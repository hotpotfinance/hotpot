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

    /// @notice Get the reward out and convert one asset to another. Note that reward token is either token0 or token1
    /// @param token0Percentage Determine what percentage of token0 to return to user. Any number between 0 to 100
    /// @param minTokenAmountConverted The minimum amount of token0 or token1 received when converting one token to the other
    function getReward(uint256 token0Percentage, uint256 minTokenAmountConverted) override public updateReward(msg.sender)  {        
        // Get rewards out and convert rewards
        stakingRewards.getReward();
        uint256 reward = _rewards[msg.sender];
        if (reward > 0) {
            _rewards[msg.sender] = 0;
            if (isToken0RewardsToken) {
                token0.safeApprove(address(converter), reward);
                converter.convert(address(token0), reward, 100 - token0Percentage, address(token1), minTokenAmountConverted, msg.sender);
            } else {
                token1.safeApprove(address(converter), reward);
                converter.convert(address(token1), reward, token0Percentage, address(token0), minTokenAmountConverted, msg.sender);
            }
        }
    }

    /// @notice Withdraw all stake from StakingRewards, remove liquidity, get the reward out and convert one asset to another
    /// @param minTokenAmountConverted The minimum amount of token0 or token1 received when converting reward token to either one of them
    /// @param minToken0AmountConverted The minimum amount of token0 received when removing liquidity
    /// @param minToken1AmountConverted The minimum amount of token1 received when removing liquidity
    /// @param token0Percentage Determine what percentage of token0 to return to user. Any number between 0 to 100
    function exit(uint256 minTokenAmountConverted, uint256 minToken0AmountConverted, uint256 minToken1AmountConverted, uint256 token0Percentage) external override {
        withdraw(minToken0AmountConverted, minToken1AmountConverted, token0Percentage, _balances[msg.sender]);
        getReward(token0Percentage, minTokenAmountConverted);
    }

    /// @notice Withdraw all stake from StakingRewards, remove liquidity, get the reward out and convert one asset to another.
    /// @param token0Percentage Determine what percentage of token0 to return to user. Any number between 0 to 100
    /// @param minTokenAmountConverted The minimum amount of token0 or token1 received when converting reward token to either one of them
    function exitWithLP(uint256 token0Percentage, uint256 minTokenAmountConverted) external override {
        withdrawWithLP(_balances[msg.sender]);
        getReward(token0Percentage, minTokenAmountConverted);
    }
}