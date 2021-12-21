pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./BaseSingleTokenStaking.sol";
import "./IWeth.sol";

/// @title A wrapper contract over StakingRewards contract that allows single asset in/out,
/// with autocompound functionality. Autocompound function collects the reward earned, convert
/// them to staking token and stake.
/// @notice Asset tokens are token0 and token1. Staking token is the LP token of token0/token1.
/// User will be earning LP tokens compounded, not the reward token from StakingRewards contract.
contract AutoCompound is BaseSingleTokenStaking {
    using SafeERC20 for IERC20;

    struct BalanceDiff {
        uint256 balBefore;
        uint256 balAfter;
        uint256 balDiff;
    }

    struct minAmountVars {
        uint256 rewardToToken0Swap;
        uint256 tokenInToTokenOutSwap;
        uint256 tokenInAddLiq;
        uint256 tokenOutAddLiq;
    }

    /* ========== STATE VARIABLES ========== */

    uint256 public lpAmountCompounded;
    address public operator;

    /* ========== CONSTRUCTOR ========== */

    function initialize(
        string memory _name,
        address _owner,
        address _operator,
        IPancakePair _lp,
        IConverter _converter,
        address _stakingRewards
    ) external {
        require(keccak256(abi.encodePacked(name)) == keccak256(abi.encodePacked("")), "Already initialized");
        super.initializePausable(_owner);
        super.initializeReentrancyGuard();

        name = _name;
        operator = _operator;
        lp = IERC20(address(_lp));
        token0 = IERC20(_lp.token0());
        token1 = IERC20(_lp.token1());
        converter = _converter;
        stakingRewards = IStakingRewards(_stakingRewards);
    }

    /* ========== VIEWS ========== */

    /// @notice Get the reward share earned by specified account.
    function _share(address account) public view returns (uint256) {
        uint256 rewardPerToken = stakingRewards.rewardPerToken();
        return (_balances[account] * (rewardPerToken - _userRewardPerTokenPaid[account]) / (1e18)) + _rewards[account];
    }

    /// @notice Get the total reward share in this contract.
    /// @notice Total reward is tracked with `_rewards[address(this)]` and `_userRewardPerTokenPaid[address(this)]`
    function _shareTotal() public view returns (uint256) {
        uint256 rewardPerToken = stakingRewards.rewardPerToken();
        return (_totalSupply * (rewardPerToken - _userRewardPerTokenPaid[address(this)]) / (1e18)) + _rewards[address(this)];
    }

    /// @notice Get the compounded LP amount earned by specified account.
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

    /// @notice Take native tokens, convert to wrapped native tokens and stake into StakingRewards contract.
    /// @param minReceivedTokenAmountSwap Minimum amount of token0 or token1 received when swapping one for the other
    /// @param minToken0AmountAddLiq The minimum amount of token0 received when adding liquidity
    /// @param minToken1AmountAddLiq The minimum amount of token1 received when adding liquidity
    function stakeWithNative(
        uint256 minReceivedTokenAmountSwap,
        uint256 minToken0AmountAddLiq,
        uint256 minToken1AmountAddLiq
    ) public payable override nonReentrant notPaused updateReward(msg.sender) {
        require(msg.value > 0, "No native tokens sent");
        IWETH NATIVE_TOKEN = IWETH(converter.NATIVE_TOKEN());
        bool isToken0 = address(NATIVE_TOKEN) == address(token0);
        require(isToken0 || address(NATIVE_TOKEN) == address(token1), "Native token is not either token0 or token1");

        NATIVE_TOKEN.deposit{ value: msg.value }();
        uint256 lpAmount = _convertAndAddLiquidity(isToken0, false, msg.value, minReceivedTokenAmountSwap, minToken0AmountAddLiq, minToken1AmountAddLiq);
        lp.safeApprove(address(stakingRewards), lpAmount);
        stakingRewards.stake(lpAmount);
    }

    /// @notice Override and intentionally failing the inherited getReward function
    function getReward(uint256 token0Percentage, uint256 minTokenAmountConverted) public override {
        revert("This function is not available");
    }

    /// @notice Get the reward out and convert one asset to another. Note that reward is LP token.
    /// @param minToken0AmountConverted The minimum amount of token0 received when removing liquidity
    /// @param minToken1AmountConverted The minimum amount of token1 received when removing liquidity
    /// @param token0Percentage Determine what percentage of token0 to return to user. Any number between 0 to 100
    function getReward(
        uint256 minToken0AmountConverted,
        uint256 minToken1AmountConverted,
        uint256 token0Percentage
    ) public updateReward(msg.sender)  {        
        uint256 reward = _rewards[msg.sender];
        uint256 totalReward = _rewards[address(this)];
        if (reward > 0) {
            // compoundedLPRewardAmount: based on user's reward and totalReward,
            // determine how many compouned(read: extra) LP amount can user take away.
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
            converter.removeLiquidityAndConvert(
                IPancakePair(address(lp)),
                compoundedLPRewardAmount,
                minToken0AmountConverted,
                minToken1AmountConverted,
                token0Percentage,
                msg.sender
            );

            emit RewardPaid(msg.sender, compoundedLPRewardAmount);
        }
    }

    /// @notice Override and intentionally failing the inherited exit function
    function exit(uint256 minTokenAmountConverted, uint256 minToken0AmountConverted, uint256 minToken1AmountConverted, uint256 token0Percentage) public override {
        revert("This function is not available");
    }

    /// @notice Withdraw all stake from StakingRewards, remove liquidity, get the reward out and convert one asset to another.
    /// @param minToken0AmountConverted The minimum amount of token0 received when removing liquidity
    /// @param minToken1AmountConverted The minimum amount of token1 received when removing liquidity
    /// @param token0Percentage Determine what percentage of token0 to return to user. Any number between 0 to 100
    function exit(uint256 minToken0AmountConverted, uint256 minToken1AmountConverted, uint256 token0Percentage) external {
        withdraw(minToken0AmountConverted, minToken1AmountConverted, token0Percentage, _balances[msg.sender]);
        getReward(minToken0AmountConverted, minToken1AmountConverted, token0Percentage);
    }

    /// @notice Override and intentionally failing the inherited exit function
    function exitWithLP(uint256 token0Percentage, uint256 minTokenAmountConverted) external override {
        revert("This function is not available");
    }

    /// @notice Withdraw all stake from StakingRewards, remove liquidity, get the reward out and convert one asset to another.
    /// @param minToken0AmountConverted The minimum amount of token0 received when removing liquidity
    /// @param minToken1AmountConverted The minimum amount of token1 received when removing liquidity
    /// @param token0Percentage Determine what percentage of token0 to return to user. Any number between 0 to 100
    function exitWithLP(uint256 minToken0AmountConverted, uint256 minToken1AmountConverted, uint256 token0Percentage) external {
        withdrawWithLP(_balances[msg.sender]);
        getReward(minToken0AmountConverted, minToken1AmountConverted, token0Percentage);
    }

    /// @notice Get all reward out from StakingRewards contract, convert half to other token, provide liquidity and stake
    /// the LP tokens back into StakingRewards contract.
    /// @dev LP tokens staked this way will be tracked in `lpAmountCompounded`.
    /// @param minAmounts The minimum amounts of
    /// 1. token0 expected to receive when swapping reward token for token0
    /// 2. tokenOut expected to receive when swapping inToken for outToken
    /// 3. tokenIn expected to add when adding liquidity
    /// 4. tokenOut expected to add when adding liquidity
    function compound(
        minAmountVars memory minAmounts
    ) external nonReentrant updateReward(address(0)) onlyOperator {
        // Get this contract's reward from StakingRewards
        uint256 rewardsLeft = stakingRewards.earned(address(this));
        if (rewardsLeft > 0) {
            stakingRewards.getReward();

            BalanceDiff memory lpAmountDiff;
            lpAmountDiff.balBefore = lp.balanceOf(address(this));
            IERC20 rewardToken = IERC20(stakingRewards.rewardsToken());

            if (address(rewardToken) == address(token0)) {
                // Convert token0 to LP tokens
                token0.safeApprove(address(converter), rewardsLeft);
                converter.convertAndAddLiquidity(
                    address(token0),
                    rewardsLeft,
                    address(token1),
                    minAmounts.tokenInToTokenOutSwap,
                    minAmounts.tokenInAddLiq,
                    minAmounts.tokenOutAddLiq,
                    address(this)
                );
            } else if (address(rewardToken) == address(token1)) {
                // Convert token1 to LP tokens
                token1.safeApprove(address(converter), rewardsLeft);
                converter.convertAndAddLiquidity(
                    address(token1),
                    rewardsLeft,
                    address(token0),
                    minAmounts.tokenInToTokenOutSwap,
                    minAmounts.tokenInAddLiq,
                    minAmounts.tokenOutAddLiq,
                    address(this)
                );
            } else {
                BalanceDiff memory token0Diff;
                // If reward token is neither token0 or token1, convert to token0 first
                token0Diff.balBefore = token0.balanceOf(address(this));
                // Convert rewards to token0
                rewardToken.safeApprove(address(converter), rewardsLeft);
                converter.convert(address(rewardToken), rewardsLeft, 100, address(token0), minAmounts.rewardToToken0Swap, address(this));
                token0Diff.balAfter = token0.balanceOf(address(this));
                token0Diff.balDiff = (token0Diff.balAfter - token0Diff.balBefore);

                // Convert converted token0 to LP tokens
                token0.safeApprove(address(converter), token0Diff.balDiff);
                converter.convertAndAddLiquidity(
                    address(token0),
                    token0Diff.balDiff,
                    address(token1),
                    minAmounts.tokenInToTokenOutSwap,
                    minAmounts.tokenInAddLiq,
                    minAmounts.tokenOutAddLiq,
                    address(this)
                );
            }

            lpAmountDiff.balAfter = lp.balanceOf(address(this));
            lpAmountDiff.balDiff = (lpAmountDiff.balAfter - lpAmountDiff.balBefore);
            // Add compounded LP tokens to lpAmountCompounded
            lpAmountCompounded = lpAmountCompounded + lpAmountDiff.balDiff;

            // Stake the compounded LP tokens back in
            lp.safeApprove(address(stakingRewards), lpAmountDiff.balDiff);
            stakingRewards.stake(lpAmountDiff.balDiff);

            emit Compounded(lpAmountDiff.balDiff);
        }
    }

    function updateOperator(address newOperator) external onlyOwner {
        operator = newOperator;

        emit UpdateOperator(newOperator);
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

    modifier onlyOperator() {
        require(msg.sender == operator, "Only the contract operator may perform this action");
        _;
    }

    /* ========== EVENTS ========== */

    event Compounded(uint256 lpAmount);
    event RewardPaid(address indexed user, uint256 rewardLPAmount);
    event UpdateOperator(address newOperator);
}