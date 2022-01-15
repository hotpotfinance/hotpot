pragma solidity ^0.8.0;

import "./BaseSingleTokenStakingCakeFarm.sol";
import "../interfaces/IStakingRewards.sol";

/// @title A wrapper contract over MasterChef contract that allows single asset in/out,
/// with operator periodically investing accrued rewards and return them with profits.
/// Contract has two states, Fund state and Lock state:
///     - During Fund state, everything is normal.
///     - During Lock state, there are some special rules applied when user wants to `stake` and `getReward`.
/// - When operator invests accrued rewards, the contract enters Lock state.
///     - During Lock state, new stake will be transferred to TempStakeManager contract and accrue rewards there.
///     - Operator need to transfer users' stake from TempStakeManager contract after contract enters Fund state.
///     - If user `getReward` during Lock state, a penalty will be applied. User will not get all rewards he earned.
/// - When operator returns rewards, the contract enters Fund state.
/// @notice Asset tokens are token0 and token1. Staking token is the LP token of token0/token1.
/// User will be earning returned rewards.
contract BetCakeFarm is BaseSingleTokenStakingCakeFarm {
    using SafeERC20 for IERC20;

    struct BalanceDiff {
        uint256 balBefore;
        uint256 balAfter;
        uint256 balDiff;
    }

    struct minAmountVars {
        uint256 cakeToStakingTokenSwap;
        uint256 rewardToToken0Swap;
        uint256 tokenInToTokenOutSwap;
        uint256 tokenInAddLiq;
        uint256 tokenOutAddLiq;
    }

    /* ========== STATE VARIABLES ========== */

    address public operator;

    /* ========== CONSTRUCTOR ========== */

    function initialize(
        string memory _name,
        address _owner,
        address _operator,
        address _BCNT,
        IERC20 _cake,
        uint256 _pid,
        IPancakePair _lp,
        IConverter _converter,
        address _masterChef,
        IStakingRewards _stakingRewards
    ) external {
        require(keccak256(abi.encodePacked(name)) == keccak256(abi.encodePacked("")), "Already initialized");
        super.initializePausable(_owner);
        super.initializeReentrancyGuard();

        name = _name;
        operator = _operator;
        BCNT = _BCNT;
        cake = _cake;
        pid = _pid;
        lp = IERC20(address(_lp));
        token0 = IERC20(_lp.token0());
        token1 = IERC20(_lp.token1());
        converter = _converter;
        masterChef = IMasterChef(_masterChef);
        stakingRewards = _stakingRewards;
        stakingRewardsStakingToken = IERC20(stakingRewards.stakingToken());
        stakingRewardsRewardsToken = IERC20(stakingRewards.rewardsToken());

        (address _poolLP, , ,) = masterChef.poolInfo(_pid);
        require(_poolLP == address(_lp), "Wrong LP token");
    }

    /* ========== VIEWS ========== */

    receive() external payable {}

    /// @notice Get the reward share earned by specified account.
    function _share(address account) public view returns (uint256) {
        UserInfo memory user = userInfo[account];

        uint256 totalAllocPoint = masterChef.totalAllocPoint();
        uint256 cakePerBlock = masterChef.cakePerBlock();
        (, uint256 allocPoint, uint256 lastRewardBlock, uint256 accCakePerShare) = masterChef.poolInfo(pid);
        uint256 lpSupply = lp.balanceOf(address(masterChef));
        if (block.number > lastRewardBlock && lpSupply != 0) {
            uint256 multiplier = masterChef.getMultiplier(lastRewardBlock, block.number);
            uint256 cakeReward = (multiplier * cakePerBlock * allocPoint) / totalAllocPoint;
            accCakePerShare = accCakePerShare + ((cakeReward * 1e12) / lpSupply);
        }
        return user.amount * accCakePerShare / 1e12 - user.rewardDebt + user.accruedReward;
    }

    /// @notice Get the total reward share in this contract.
    /// @notice Total reward is tracked with `_rewards[address(this)]` and `_userRewardPerTokenPaid[address(this)]`
    function _shareTotal() public view returns (uint256) {
        return _share(address(this));
    }

    /// @notice Get the compounded LP amount earned by specified account.
    function earned(address account) public override view returns (uint256) {

    }

    /* ========== MUTATIVE FUNCTIONS ========== */

    /// @inheritdoc BaseSingleTokenStakingCakeFarm
    function withdraw(
        uint256 minToken0AmountConverted,
        uint256 minToken1AmountConverted,
        uint256 token0Percentage,
        uint256 amount
    ) public override nonReentrant updateReward(msg.sender) {

    }

    /// @inheritdoc BaseSingleTokenStakingCakeFarm
    function withdrawWithLP(uint256 lpAmount) public override nonReentrant notPaused updateReward(msg.sender) {

    }

    /// @inheritdoc BaseSingleTokenStakingCakeFarm
    function withdrawWithNative(uint256 minToken0AmountConverted, uint256 minToken1AmountConverted, uint256 amount) public override nonReentrant notPaused updateReward(msg.sender) {

    }

    /// @notice Get the reward out and convert one asset to another. Note that reward is LP token.
    /// @param minToken0AmountConverted The minimum amount of token0 received when removing liquidity
    /// @param minToken1AmountConverted The minimum amount of token1 received when removing liquidity
    /// @param minBCNTAmountConverted The minimum amount of BCNT received swapping token0 for BCNT
    function getReward(
        uint256 minToken0AmountConverted,
        uint256 minToken1AmountConverted,
        uint256 minBCNTAmountConverted
    ) public override updateReward(msg.sender) {

    }

    /// @notice Withdraw all stake from StakingRewards, remove liquidity, get the reward out and convert one asset to another.
    /// @param minToken0AmountConverted The minimum amount of token0 received when removing liquidity
    /// @param minToken1AmountConverted The minimum amount of token1 received when removing liquidity
    /// @param minBCNTAmountConverted The minimum amount of BCNT received swapping token0 for BCNT
    /// @param token0Percentage Determine what percentage of token0 to return to user. Any number between 0 to 100
    function exit(uint256 minToken0AmountConverted, uint256 minToken1AmountConverted, uint256 minBCNTAmountConverted, uint256 token0Percentage) external override {
        withdraw(minToken0AmountConverted, minToken1AmountConverted, token0Percentage, userInfo[msg.sender].amount);
        getReward(minToken0AmountConverted, minToken1AmountConverted, minBCNTAmountConverted);
    }

    /// @notice Withdraw all stake from StakingRewards, remove liquidity, get the reward out and convert one asset to another.
    /// @param minToken0AmountConverted The minimum amount of token0 received when removing liquidity
    /// @param minToken1AmountConverted The minimum amount of token1 received when removing liquidity
    /// @param minBCNTAmountConverted The minimum amount of BCNT received swapping token0 for BCNT
    function exitWithLP(uint256 minToken0AmountConverted, uint256 minToken1AmountConverted, uint256 minBCNTAmountConverted) external override {
        withdrawWithLP(userInfo[msg.sender].amount);
        getReward(minToken0AmountConverted, minToken1AmountConverted, minBCNTAmountConverted);
    }

    /// @inheritdoc BaseSingleTokenStakingCakeFarm
    function exitWithNative(uint256 token0Percentage, uint256 minToken0AmountConverted, uint256 minToken1AmountConverted, uint256 minTokenAmountConverted) external override {
        withdrawWithNative(minToken0AmountConverted, minToken1AmountConverted, userInfo[msg.sender].amount);
        getReward(minToken0AmountConverted, minToken1AmountConverted, minTokenAmountConverted);
    }

    function _convertCakeToStakingToken(uint256 cakeLeft, minAmountVars memory minAmounts) internal {

    }

    /// @notice compound is split into two parts but pipelined, both part will be exectued each time:
    /// First part: get all Cake out from MasterChef contract, convert all to staking token of StakingRewards contract
    /// Second part: get all rewards out from StakingReward, convert rewards to both token0 and token1 and provide liquidity and stake
    /// the LP tokens back into MasterChef contract.
    /// @dev LP tokens staked this way will be tracked in `lpAmountCompounded`.
    /// @param minAmounts The minimum amounts of
    /// 1. stakingRewardsStakingToken expected to receive when swapping Cake for stakingRewardsStakingToken
    /// 2. token0 expected to receive when swapping stakingRewardsRewardsToken for token0
    /// 3. tokenOut expected to receive when swapping inToken for outToken
    /// 4. tokenIn expected to add when adding liquidity
    /// 5. tokenOut expected to add when adding liquidity
    function compound(
        minAmountVars memory minAmounts
    ) external nonReentrant updateReward(address(0)) onlyOperator {

    }

    function updateOperator(address newOperator) external onlyOwner {
        operator = newOperator;

        emit UpdateOperator(newOperator);
    }

    /* ========== MODIFIERS ========== */

    modifier updateReward(address account) override {
        masterChef.updatePool(pid);
        uint256 accCakePerShare = _getAccCakePerShare();
        UserInfo storage user = userInfo[account];
        UserInfo storage total = userInfo[address(this)];

        if (account != address(0)) {
            uint256 userPending = user.amount * accCakePerShare / 1e12 - user.rewardDebt;
            user.accruedReward = user.accruedReward + userPending;
            uint256 totalPending = total.amount * accCakePerShare / 1e12 - total.rewardDebt;
            total.accruedReward = total.accruedReward + totalPending;
        }

        _;

        if (account != address(0)) {
            user.rewardDebt = user.amount * accCakePerShare / 1e12;
            total.rewardDebt = total.amount * accCakePerShare / 1e12;
        }
    }

    modifier onlyOperator() {
        require(msg.sender == operator, "Only the contract operator may perform this action");
        _;
    }

    /* ========== EVENTS ========== */

    event Withdrawn(address indexed user, uint256 autoCompoundStakingTokenAmount, uint256 stakingRewardsStakingTokenAmount);
    event StakedToStakingReward(uint256 stakeAmount);
    event Compounded(uint256 lpAmount);
    event RewardPaid(address indexed user, uint256 rewardLPAmount);
    event UpdateOperator(address newOperator);
}