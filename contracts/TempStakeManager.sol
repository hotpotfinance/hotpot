pragma solidity ^0.8.0;

import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./BaseSingleTokenStaking.sol";
import "./IPancakeRouter.sol";

/// @title A contract for temporarily managin stake for users. 
/// @notice When main contract calls `stake`, it receives LP token from main contract and stake it.
/// When main contract calls `exit`, it withdraws stake, get reward and convert reward to LP token
/// and transfer LP token to main contract.
contract TempStakeManager is BaseSingleTokenStaking {
    using EnumerableSet for EnumerableSet.AddressSet;
    using SafeERC20 for IERC20;

    struct BalanceDiff {
        uint256 balBefore;
        uint256 balAfter;
        uint256 balDiff;
    }

    struct RewardRelatedVars {
        uint256 reward;
        IERC20 rewardToken;
        IERC20 otherToken;
    }

    struct minAmountVars {
        uint256 rewardToToken0Swap;
        uint256 tokenInAddLiq;
        uint256 tokenOutAddLiq;
    }

    /* ========== STATE VARIABLES ========== */

    address public mainContract;
    EnumerableSet.AddressSet private _stakerList;

    /* ========== CONSTRUCTOR ========== */

    function initialize(
        string memory _name,
        address _owner,
        IPancakePair _lp,
        IConverter _converter,
        IStakingRewards _stakingRewards,
        address _mainContract
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

        mainContract = _mainContract;
    }

    /* ========== VIEWS ========== */

    function getStakerAt(uint256 index) public view returns (address) {
        return _stakerList.at(index);
    }

    function getStakersUpto(uint256 index) public view returns (address[] memory) {
        address[] memory stakerList = new address[](index);
        for (uint256 i = 0; i < index; i++) {
            stakerList[i] = (_stakerList.at(i));
        }
        return stakerList;
    }

    function getAllStakers() public view returns (address[] memory) {
        uint256 numStaker = _stakerList.length();
        address[] memory stakerList = new address[](numStaker);
        for (uint256 i = 0; i < numStaker; i++) {
            stakerList[i] = (_stakerList.at(i));
        }
        return stakerList;
    }

    /// @dev Get the reward earned by specified account
    function earned(address account) public override view returns (uint256) {
        uint256 rewardPerToken = stakingRewards.rewardPerToken();
        return (_balances[account] * (rewardPerToken - _userRewardPerTokenPaid[account]) / (1e18)) + _rewards[account];
    }

    /* ========== MUTATIVE FUNCTIONS ========== */

    /// @notice Override and intentionally failing the normal stake function
    function stake(
        bool isToken0,
        uint256 amount,
        uint256 minReceivedTokenAmountSwap,
        uint256 minToken0AmountAddLiq,
        uint256 minToken1AmountAddLiq
    ) public override {
        revert("This function is not available");
    }

    /// @notice Receive LP tokens from main contract and stake it.
    /// @param staker Account that is staking
    /// @param lpAmount Amount of lp token staker staked and transfer to this contract
    function stake(address staker, uint256 lpAmount) public onlyMainContract nonReentrant notPaused updateReward(staker) {
        // Top up staker's balance
        _totalSupply = _totalSupply + lpAmount;
        _balances[staker] = _balances[staker] + lpAmount;
        lp.safeApprove(address(stakingRewards), lpAmount);
        stakingRewards.stake(lpAmount);

        _stakerList.add(staker);

        emit Staked(staker, lpAmount);
    }

    /// @notice Override and intentionally failing the normal withdraw function
    function withdraw(uint256 minToken0AmountConverted, uint256 minToken1AmountConverted, uint256 token0Percentage, uint256 amount) public override {
        revert("This function is not available");
    }

    /// @notice Override and intentionally failing the normal getReward function
    function getReward(uint256 token0Percentage, uint256 minTokenAmountConverted) public override {
        revert("This function is not available");
    }

    /// @notice Override and intentionally failing the inherited exit function
    function exit(uint256 minTokenAmountConverted, uint256 minToken0AmountConverted, uint256 minToken1AmountConverted, uint256 token0Percentage) public override {
        revert("This function is not available");
    }

    /// @notice Withdraw stake from StakingRewards, get the reward out and convert reward to LP token
    /// and transfer LP token to main contract.
    /// @param staker Account that is staking
    /// @param minAmounts The minimum amounts of
    /// 1. token0 expected to receive when swapping reward token for token0
    /// 2. tokenIn expected to add when adding liquidity
    /// 3. tokenOut expected to add when adding liquidity
    /// @return lpAmount Amount of LP token withdrawn
    /// @return convertedLPAmount Amount of LP token converted from reward
    function exit(address staker, minAmountVars memory minAmounts) external onlyMainContract nonReentrant updateReward(staker) returns (uint256, uint256) {
        uint256 lpAmount = _balances[staker];

        // Clean up staker's balance
        _totalSupply = _totalSupply - lpAmount;
        _balances[staker] = 0;
        // Withdraw stake
        stakingRewards.withdraw(lpAmount);

        // Get reward and convert to LP token
        stakingRewards.getReward();
        BalanceDiff memory lpAmountDiff;
        RewardRelatedVars memory rewardVars;
        rewardVars.reward = _rewards[staker];
        if (rewardVars.reward > 0) {
            _rewards[staker] = 0;

            (rewardVars.rewardToken, rewardVars.otherToken) = isToken0RewardsToken ? (token0, token1) : (token1, token0);
            lpAmountDiff.balBefore = lp.balanceOf(address(this));

            // Convert rewards to LP tokens
            rewardVars.rewardToken.safeApprove(address(converter), rewardVars.reward);
            converter.convertAndAddLiquidity(
                address(rewardVars.rewardToken),
                rewardVars.reward,
                address(rewardVars.otherToken),
                minAmounts.rewardToToken0Swap,
                minAmounts.tokenInAddLiq,
                minAmounts.tokenOutAddLiq,
                address(this)
            );

            lpAmountDiff.balAfter = lp.balanceOf(address(this));
            lpAmountDiff.balDiff = (lpAmountDiff.balAfter - lpAmountDiff.balBefore);
            emit ConvertedLP(staker, lpAmountDiff.balDiff);
        }

        _stakerList.remove(staker);

        // Transfer withdrawn LP amount plus converted LP amount
        lp.transfer(mainContract, lpAmount + lpAmountDiff.balDiff);
        emit Withdrawn(staker, lpAmount);

        return (lpAmount, lpAmountDiff.balDiff);
    }

    /// @notice Withdraw stake from StakingRewards, get the reward out send them to staker
    /// @param staker Account that is aborting
    function abort(address staker) external onlyMainContract nonReentrant updateReward(staker) {
        uint256 lpAmount = _balances[staker];
        if (lpAmount > 0) {
            // Clean up staker's balance
            _totalSupply = _totalSupply - lpAmount;
            _balances[staker] = 0;
            // Withdraw stake
            stakingRewards.withdraw(lpAmount);
            // Transfer withdrawn LP
            lp.transfer(staker, lpAmount);
            emit Abort(staker, lpAmount);
        }

        // Get reward
        stakingRewards.getReward();
        uint256 reward = _rewards[staker];
        if (reward > 0) {
            // Clean up staker's reward
            _rewards[staker] = 0;
            // Transfer reward
            address rewardToken = isToken0RewardsToken ? address(token0) : address(token1);
            IERC20(rewardToken).safeTransfer(staker, reward);
            emit RewardPaid(staker, reward);
        }

        _stakerList.remove(staker);
    }

    /* ========== RESTRICTED FUNCTIONS ========== */

    function updateMainContract(address newMainContract) external onlyOwner {
        mainContract = newMainContract;
    }

    /* ========== MODIFIERS ========== */

    modifier onlyMainContract() {
        require(msg.sender == mainContract, "Only the contract operator may perform this action");
        _;
    }

    /* ========== EVENTS ========== */

    event ConvertedLP(address indexed user, uint256 rewardLPAmount);
    event Abort(address indexed user, uint256 lpAmount);
    event RewardPaid(address indexed user, uint256 rewardAmount);
}