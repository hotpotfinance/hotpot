pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./BaseSingleTokenStaking.sol";

/// @title A wrapper contract over StakingRewards contract that allows single asset in/out.
/// 1. User provide token0 or token1
/// 2. contract converts half to the other token and provide liquidity
/// 3. stake into underlying StakingRewards contract
/// @notice Asset tokens are token0 and token1. Staking token is the LP token of token0/token1.
contract SingleTokenStaking is BaseSingleTokenStaking {
    using SafeERC20 for IERC20;

    /* ========== VIEWS ========== */

    function userRewardPerTokenPaid(address account) external view returns (uint256) {
        return _userRewardPerTokenPaid[account];
    }

    function rewards(address account) external view returns (uint256) {
        return _rewards[account];
    }

    /* ========== CONSTRUCTOR ========== */

    function initialize(
        string memory _name,
        address _owner,
        IPancakePair _lp,
        IConverter _converter,
        IStakingRewards _stakingRewards
    ) external {
        require(keccak256(abi.encodePacked(name)) == keccak256(abi.encodePacked("")), "Already initialized");
        super.initializePausable(_owner);
        super.initializeReentrancyGuard();

        name = _name;
        lp = IERC20(address(_lp));
        token0 = IERC20(_lp.token0());
        token1 = IERC20(_lp.token1());
        converter = _converter;
        stakingRewards = _stakingRewards;
        isToken0RewardsToken = (stakingRewards.rewardsToken() == address(token0));
    }

    /* ========== VIEWS ========== */

    /// @notice Get the reward earned by specified account.
    function earned(address account) public override view returns (uint256) {
        uint256 rewardPerToken = stakingRewards.rewardPerToken();
        return (_balances[account] * (rewardPerToken - _userRewardPerTokenPaid[account]) / (1e18)) + _rewards[account];
    }

    /* ========== MUTATIVE FUNCTIONS ========== */

    /// @notice Withdraw stake from StakingRewards, remove liquidity and convert one asset to another.
    /// @param token0Percentage Determine what percentage of token0 to return to user. Any number between 0 to 100
    /// @param amount Amount of stake to withdraw
    function withdraw(uint256 token0Percentage, uint256 amount) public override nonReentrant updateReward(msg.sender) {
        require(amount > 0, "Cannot withdraw 0");
        _totalSupply = (_totalSupply - amount);
        _balances[msg.sender] = (_balances[msg.sender] - amount);

        // Withdraw
        stakingRewards.withdraw(amount);

        lp.safeApprove(address(converter), amount);
        converter.removeLiquidityAndConvert(IPancakePair(address(lp)), amount, token0Percentage, msg.sender);

        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Get the reward out and convert one asset to another. Note that reward token is either token0 or token1
    /// @param token0Percentage Determine what percentage of token0 to return to user. Any number between 0 to 100
    function getReward(uint256 token0Percentage) override public updateReward(msg.sender)  {        
        // Get rewards out and convert rewards
        stakingRewards.getReward();
        uint256 reward = _rewards[msg.sender];
        if (reward > 0) {
            _rewards[msg.sender] = 0;
            if (isToken0RewardsToken) {
                token0.safeApprove(address(converter), reward);
                converter.convert(address(token0), reward, 100 - token0Percentage, address(token1), 0, msg.sender);
            } else {
                token1.safeApprove(address(converter), reward);
                converter.convert(address(token1), reward, token0Percentage, address(token0), 0, msg.sender);
            }
        }
    }

    /// @notice Withdraw all stake from StakingRewards, remove liquidity, get the reward out and convert one asset to another
    /// @param token0Percentage Determine what percentage of token0 to return to user. Any number between 0 to 100
    function exit(uint256 token0Percentage) external override {
        withdraw(token0Percentage, _balances[msg.sender]);
        getReward(token0Percentage);
    }
}