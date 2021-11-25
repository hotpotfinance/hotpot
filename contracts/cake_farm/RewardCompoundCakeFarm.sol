pragma solidity ^0.8.0;

import "./BaseSingleTokenStakingCakeFarm.sol";
import "../IStakingRewards.sol";

/// @title A wrapper contract over StakingRewards contract that allows single asset in/out,
/// with autocompound functionality. Autocompound function collects the reward earned, convert
/// them to staking token and stake.
/// @notice Asset tokens are token0 and token1. Staking token is the LP token of token0/token1.
/// User will be earning LP tokens compounded, not the reward token from StakingRewards contract.
contract RewardCompoundCakeFarm is BaseSingleTokenStakingCakeFarm {
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

    IStakingRewards public stakingRewards;
    IERC20 public stakingRewardsStakingToken;
    IERC20 public stakingRewardsRewardsToken;
    uint256 public lpAmountCompounded;
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

    function _withdrawFromStakingRewards(uint256 amount, uint256 totalAmount) internal returns (uint256) {
        uint256 reward = userInfo[msg.sender].accruedReward;
        uint256 totalReward = userInfo[address(this)].accruedReward;
        uint256 stakingRewardsBalance = stakingRewards.balanceOf(address(this));
        uint256 amountToWithdrawFromStakingRewards;
        if (totalReward > 0 && reward > 0 && stakingRewardsBalance > 0) {
            // Amount to withdraw from StakingRewards is proportional to user's reward portion and amount portion
            // relative to total reward and total amount
            amountToWithdrawFromStakingRewards = stakingRewardsBalance * reward * amount / totalReward / totalAmount;
            stakingRewards.withdraw(amountToWithdrawFromStakingRewards);
            stakingRewardsStakingToken.safeTransfer(msg.sender, amountToWithdrawFromStakingRewards);
        }
        return amountToWithdrawFromStakingRewards;
    }

    /// @notice Withdraw stake from StakingRewards, remove liquidity and convert one asset to another.
    /// @param minToken0AmountConverted The minimum amount of token0 received when removing liquidity
    /// @param minToken1AmountConverted The minimum amount of token1 received when removing liquidity
    /// @param token0Percentage Determine what percentage of token0 to return to user. Any number between 0 to 100
    /// @param amount Amount of stake to withdraw
    function withdraw(
        uint256 minToken0AmountConverted,
        uint256 minToken1AmountConverted,
        uint256 token0Percentage,
        uint256 amount
    ) public override nonReentrant updateReward(msg.sender) {
        require(amount > 0, "Cannot withdraw 0");
        uint256 userTotalAmount = userInfo[msg.sender].amount;

        // Update records:
        // substract withdrawing LP amount from total LP amount staked
        userInfo[address(this)].amount = (userInfo[address(this)].amount - amount);
        // substract withdrawing LP amount from user's balance
        userInfo[msg.sender].amount = (userInfo[msg.sender].amount - amount);

        // Withdraw from Master Chef
        masterChef.withdraw(pid, amount);

        lp.safeApprove(address(converter), amount);
        converter.removeLiquidityAndConvert(
            IPancakePair(address(lp)),
            amount,
            minToken0AmountConverted,
            minToken1AmountConverted,
            token0Percentage,
            msg.sender
        );

        // Withdraw from StakingRewards
        uint256 amountToWithdrawFromStakingRewards = _withdrawFromStakingRewards(amount, userTotalAmount);

        emit Withdrawn(msg.sender, amount, amountToWithdrawFromStakingRewards);
    }

    /// @notice Withdraw LP tokens from StakingRewards contract and return to user.
    /// @param lpAmount Amount of LP tokens to withdraw
    function withdrawWithLP(uint256 lpAmount) public override nonReentrant notPaused updateReward(msg.sender) {
        require(lpAmount > 0, "Cannot withdraw 0");
        uint256 userTotalAmount = userInfo[msg.sender].amount;

        // Update records:
        // substract withdrawing LP amount from total LP amount staked
        userInfo[address(this)].amount = (userInfo[address(this)].amount - lpAmount);
        // substract withdrawing LP amount from user's balance
        userInfo[msg.sender].amount = (userInfo[msg.sender].amount - lpAmount);

        // Withdraw from Master Chef
        masterChef.withdraw(pid, lpAmount);
        lp.safeTransfer(msg.sender, lpAmount);

        // Withdraw from StakingRewards
        uint256 amountToWithdrawFromStakingRewards = _withdrawFromStakingRewards(lpAmount, userTotalAmount);

        emit Withdrawn(msg.sender, lpAmount, amountToWithdrawFromStakingRewards);
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
        uint256 reward = userInfo[msg.sender].accruedReward;
        uint256 totalReward = userInfo[address(this)].accruedReward;
        if (reward > 0) {
            // compoundedLPRewardAmount: based on user's reward and totalReward,
            // determine how many compouned(read: extra) LP amount can user take away.
            // NOTE: totalReward = _rewards[address(this)];
            uint256 compoundedLPRewardAmount = lpAmountCompounded * reward / totalReward;

            // Update records:
            // add user's claimed rewards to rewardDebt
            userInfo[msg.sender].accruedReward = 0;
            userInfo[address(this)].accruedReward = userInfo[address(this)].accruedReward - reward;
            // substract compoundedLPRewardAmount from lpAmountCompounded
            lpAmountCompounded = (lpAmountCompounded - compoundedLPRewardAmount);

            // Withdraw from compounded LP
            masterChef.withdraw(pid, compoundedLPRewardAmount);

            lp.safeApprove(address(converter), compoundedLPRewardAmount);
            converter.removeLiquidityAndConvert(
                IPancakePair(address(lp)),
                compoundedLPRewardAmount,
                minToken0AmountConverted,
                minToken1AmountConverted,
                100, // Convert 100% to token0
                address(this) // Need to send token0 here to convert them to BCNT
            );

            // Convert token0 to BCNT
            uint256 token0Balance = token0.balanceOf(address(this));
            token0.safeApprove(address(converter), token0Balance);
            converter.convert(
                address(token0),
                token0Balance,
                100, // Convert 100% to BCNT
                BCNT,
                minBCNTAmountConverted,
                msg.sender
            );

            emit RewardPaid(msg.sender, compoundedLPRewardAmount);
        }
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

    function _convertCakeToStakingToken(uint256 cakeLeft, minAmountVars memory minAmounts) internal {
        masterChef.deposit(pid, 0);

        // Convert Cake to stakingRewardsStakingToken
        BalanceDiff memory stakingTokenDiff;
        stakingTokenDiff.balBefore = stakingRewardsStakingToken.balanceOf(address(this));
        cake.safeApprove(address(converter), cakeLeft);
        converter.convert(address(cake), cakeLeft, 100, address(stakingRewardsStakingToken), minAmounts.cakeToStakingTokenSwap, address(this));
        stakingTokenDiff.balAfter = stakingRewardsStakingToken.balanceOf(address(this));
        stakingTokenDiff.balDiff = (stakingTokenDiff.balAfter - stakingTokenDiff.balBefore);

        stakingRewardsStakingToken.safeApprove(address(stakingRewards), stakingTokenDiff.balDiff);
        stakingRewards.stake(stakingTokenDiff.balDiff);

        emit StakedToStakingReward(stakingTokenDiff.balDiff);
    }

    function _convertRewardsTokenToLPToken(uint256 rewardsLeft, minAmountVars memory minAmounts) internal {
        stakingRewards.getReward();

        // Convert rewards to token0
        BalanceDiff memory token0Diff;
        token0Diff.balBefore = token0.balanceOf(address(this));
        stakingRewardsRewardsToken.safeApprove(address(converter), rewardsLeft);
        converter.convert(address(stakingRewardsRewardsToken), rewardsLeft, 100, address(token0), minAmounts.rewardToToken0Swap, address(this));
        token0Diff.balAfter = token0.balanceOf(address(this));
        token0Diff.balDiff = (token0Diff.balAfter - token0Diff.balBefore);

        // Convert converted token0 to LP tokens
        BalanceDiff memory lpAmountDiff;
        lpAmountDiff.balBefore = lp.balanceOf(address(this));
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

        lpAmountDiff.balAfter = lp.balanceOf(address(this));
        lpAmountDiff.balDiff = (lpAmountDiff.balAfter - lpAmountDiff.balBefore);
        // Add compounded LP tokens to lpAmountCompounded
        lpAmountCompounded = lpAmountCompounded + lpAmountDiff.balDiff;

        // Stake the compounded LP tokens back in
        lp.safeApprove(address(masterChef), lpAmountDiff.balDiff);
        masterChef.deposit(pid, lpAmountDiff.balDiff);

        emit Compounded(lpAmountDiff.balDiff);
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
        // Get cake from MasterChef plus remaining cake on this contract
        // NOTE: cake is collected everytime the contract deposit to/withdraw from MasterChef
        // so pendingCake is not all the cake collected.
        uint256 pendingCakeLeft = masterChef.pendingCake(pid, address(this));
        uint256 cakeLeft = pendingCakeLeft + cake.balanceOf(address(this));
        if (cakeLeft > 0) {
            _convertCakeToStakingToken(cakeLeft, minAmounts);
        }

        // Get this contract's reward from StakingRewards
        uint256 rewardsLeft = stakingRewards.earned(address(this));
        if (rewardsLeft > 0) {
            _convertRewardsTokenToLPToken(rewardsLeft, minAmounts);
        }
    }

    function updateOperator(address newOperator) external onlyOwner {
        operator = newOperator;
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
}