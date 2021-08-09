pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./BaseSingleTokenStaking.sol";

/// @title A staking contract wrapper for single asset in/out, with autocompound functionality.
/// autocompound function collects the reward earned, convert them to staking token and stake
/// @notice Asset tokens are token0 and token1. Staking token is the LP token of token0/token1.
/// User will be earning LP tokens compounded, not the reward token from StakingRewards contract
contract AutoCompound is BaseSingleTokenStaking {
    using SafeERC20 for IERC20;

    /* ========== STATE VARIABLES ========== */

    uint256 public lpAmountCompounded;

    /* ========== CONSTRUCTOR ========== */

    function initialize(
        string memory _name,
        address _owner,
        address _converter,
        address _stakingRewards
    ) external {
        require(keccak256(abi.encodePacked(name)) == keccak256(abi.encodePacked("")), "Already initialized");
        super.initializePausable(_owner);
        super.initializeReentrancyGuard();

        name = _name;
        converter = IConverter(_converter);
        lp = IERC20(converter.lp());
        token0 = IERC20(converter.token0());
        token1 = IERC20(converter.token1());
        stakingRewards = IStakingRewards(_stakingRewards);
        isToken0RewardsToken = (stakingRewards.rewardsToken() == address(token0));
    }

    /* ========== VIEWS ========== */

    /// @dev Get the reward earned by specified account
    function _share(address account) public view returns (uint256) {
        uint256 rewardPerToken = stakingRewards.rewardPerToken();
        return (_balances[account] * (rewardPerToken - _userRewardPerTokenPaid[account]) / (1e18)) + _rewards[account];
    }

    /// @dev Get the reward earned by all accounts in this contract
    /// We track the total reward with _rewards[address(this)] and _userRewardPerTokenPaid[address(this)]
    function _shareTotal() public view returns (uint256) {
        uint256 rewardPerToken = stakingRewards.rewardPerToken();
        return (_totalSupply * (rewardPerToken - _userRewardPerTokenPaid[address(this)]) / (1e18)) + _rewards[address(this)];
    }

    /// @dev Get the compounded LP amount earned by specified account
    function earned(address account) public override view returns (uint256) {
        uint256 rewardsShare;
        if (account == address(this)){
            rewardsShare = _shareTotal();
        } else {
            rewardsShare = _share(account);
        }

        uint256 earnedCompoundedLPAmount;
        if (rewardsShare > 0) {
            uint256 totalShare = _shareTotal();
            // Earned compounded LP amount is proportional to how many rewards this account has
            // among total rewards
            earnedCompoundedLPAmount = lpAmountCompounded * rewardsShare / totalShare;
        }
        return earnedCompoundedLPAmount;
    }

    /* ========== MUTATIVE FUNCTIONS ========== */

    /// @notice Withdraw stake from StakingRewards, remove liquidity and convert one asset to another.
    /// @param token0Percentage Determine what percentage of token0 to return to user. Any number between 0 to 100
    /// @param amount Amount of stake to withdraw
    function withdraw(uint256 token0Percentage, uint256 amount) public override nonReentrant updateReward(msg.sender) {
        require(amount > 0, "Cannot withdraw 0");

        // Update records:
        // substract withdrawing lp amount from total lp amount staked
        _totalSupply = (_totalSupply - amount);
        // substract withdrawing lp amount from user's balance
        _balances[msg.sender] = (_balances[msg.sender] - amount);

        // Withdraw
        stakingRewards.withdraw(amount);

        lp.safeApprove(address(converter), amount);
        converter.removeLiquidityAndConvert(amount, token0Percentage, msg.sender);

        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Get the reward out and convert one asset to another. Note that reward token is either token0 or token1
    /// @param token0Percentage Determine what percentage of token0 to return to user. Any number between 0 to 100
    function getReward(uint256 token0Percentage) public updateReward(msg.sender)  {        
        uint256 reward = _rewards[msg.sender];
        uint256 totalReward = _rewards[address(this)];
        if (reward > 0) {
            // compoundedLPRewardAmount: based on user's reward and totalReward,
            // determine how many compouned(read: extra) lp amount can user take away.
            // NOTE: totalReward = _rewards[address(this)];
            uint256 compoundedLPRewardAmount = lpAmountCompounded * reward / totalReward;

            // Update records:
            // substract user's rewards from totalReward
            _rewards[msg.sender] = 0;
            _rewards[address(this)] = (totalReward - reward);
            // substract compoundedLPRewardAmount from lpAmountCompounded
            lpAmountCompounded = (lpAmountCompounded - compoundedLPRewardAmount);

            // Withdraw from compounded LP
            stakingRewards.withdraw(compoundedLPRewardAmount);

            lp.safeApprove(address(converter), compoundedLPRewardAmount);
            converter.removeLiquidityAndConvert(compoundedLPRewardAmount, token0Percentage, msg.sender);

            emit RewardPaid(msg.sender, compoundedLPRewardAmount);
        }
    }

    /// @notice Withdraw all stake from StakingRewards, remove liquidity, get the reward out and convert one asset to another
    /// @param token0Percentage Determine what percentage of token0 to return to user. Any number between 0 to 100
    function exit(uint256 token0Percentage) external override {
        withdraw(token0Percentage, _balances[msg.sender]);
        getReward(token0Percentage);
    }

    /// @notice Get all reward out, convert half to other token, provide liquidity and stake
    /// the lp tokens back into StakingRewards
    /// @dev LP tokens staked this way will be tracked in lpAmountCompounded instead of single account's balance
    /// since they belong to all stakers
    function compound() external nonReentrant updateReward(address(0)) {
        // Get this contract's reward from StakingRewards
        uint256 rewardsLeft = stakingRewards.earned(address(this));
        if (rewardsLeft > 0) {
            stakingRewards.getReward();

            address rewardToken = isToken0RewardsToken ? address(token0) : address(token1);
            uint256 lpAmountBefore = lp.balanceOf(address(this));

            // Convert rewards to LP tokens
            IERC20(rewardToken).safeApprove(address(converter), rewardsLeft);
            converter.convertAndAddLiquidity(rewardToken, rewardsLeft, 0, address(this));

            uint256 lpAmountAfter = lp.balanceOf(address(this));
            uint256 lpAmount = (lpAmountAfter - lpAmountBefore);
            // Add compounded LP tokens to lpAmountCompounded
            lpAmountCompounded = lpAmountCompounded + lpAmount;

            // Stake the compounded LP tokens back in
            lp.safeApprove(address(stakingRewards), lpAmount);
            stakingRewards.stake(lpAmount);

            emit Compounded(lpAmount);
        }
    }

    /* ========== MODIFIERS ========== */

    modifier updateReward(address account) override {
        uint256 rewardPerTokenStored = stakingRewards.rewardPerToken();
        if (account != address(0)) {
            _rewards[account] = _share(account);
            _userRewardPerTokenPaid[account] = rewardPerTokenStored;

            // Use _rewards[address(this)] to keep track of rewards earned by all accounts.
            // NOTE: it does not count into the compounded reward because compouned reward
            // are continuosly converted to LP tokens and user will be rewarded with
            // compounded LP tokens instead of compounded rewards.
            _rewards[address(this)] = _shareTotal();
            _userRewardPerTokenPaid[address(this)] = rewardPerTokenStored;
        }
        _;
    }

    /* ========== EVENTS ========== */

    event Compounded(uint256 lpAmount);
    event RewardPaid(address indexed user, uint256 rewardLPAmount);
}