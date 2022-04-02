pragma solidity ^0.8.0;

import "./BaseSingleTokenStakingCakeFarm.sol";
import "../interfaces/ITempStakeManagerCakeFarm.sol";

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

    enum State { Fund, Lock }

    struct BalanceDiff {
        uint256 balBefore;
        uint256 balAfter;
        uint256 balDiff;
    }

    struct minAmountVars {
        uint256 cakeToBCNTSwap;
        uint256 rewardToToken0Swap;
        uint256 tokenInToTokenOutSwap;
        uint256 tokenInAddLiq;
        uint256 tokenOutAddLiq;
    }

    /* ========== STATE VARIABLES ========== */

    State internal state;
    uint256 public bonus;
    address public operator;
    address public liquidityProvider;
    ITempStakeManagerCakeFarm public tempStakeManager;
    uint256 public penaltyPercentage;
    uint256 public period;
    mapping(address => uint256) public stakerLastGetRewardPeriod;


    /* ========== CONSTRUCTOR ========== */

    function initialize(
        string memory _name,
        address _owner,
        address _BCNT,
        IERC20 _cake,
        uint256 _pid,
        IConverter _converter,
        IMasterChef _masterChef,
        address _operator,
        address _liquidityProvider,
        ITempStakeManagerCakeFarm _tempStakeManager,
        uint256 _penaltyPercentage
    ) external {
        require(keccak256(abi.encodePacked(name)) == keccak256(abi.encodePacked("")), "Already initialized");
        super.initializePausable(_owner);
        super.initializeReentrancyGuard();

        name = _name;
        BCNT = _BCNT;
        cake = _cake;
        pid = _pid;
        converter = _converter;
        masterChef = _masterChef;

        (address _poolLP, , ,) = masterChef.poolInfo(_pid);
        lp = IERC20(_poolLP);
        token0 = IERC20(IPancakePair(_poolLP).token0());
        token1 = IERC20(IPancakePair(_poolLP).token1());

        period = 1;
        state = State.Fund;
        operator = _operator;
        liquidityProvider = _liquidityProvider;
        tempStakeManager = _tempStakeManager;
        penaltyPercentage = _penaltyPercentage;
    }

    /* ========== VIEWS ========== */

    /// @notice Get the State of the contract.
    function getState() public view returns (string memory) {
        if (state == State.Fund) return "Fund";
        else return "Lock";
    }

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
    /// @notice Total reward is tracked with `userInfo[address(this)].accruedReward`
    function _shareTotal() public view returns (uint256) {
        return _share(address(this));
    }

    /// @notice Get the reward amount earned by specified account.
    function earned(address account) public override view returns (uint256) {
        // Can not getReward if already did in this period
        if (stakerLastGetRewardPeriod[account] >= period) return 0;

        uint256 rewardsShare;
        if (account == address(this)){
            rewardsShare = _shareTotal();
        } else {
            rewardsShare = _share(account);
        }

        uint256 earnedBonusAmount;
        if (rewardsShare > 0) {
            uint256 totalShare = _shareTotal();
            // Earned bonus amount is proportional to how many rewards this account has
            // among total rewards
            earnedBonusAmount = bonus * rewardsShare / totalShare;
        }
        return earnedBonusAmount;
    }

    /// @notice Get the locked reward amount earned by specified account.
    /// "Locked" means this is not the bonus for user to claim. This is the reward used to cook.
    /// Only the reward served is available for user to claim.
    /// This function is used to preview the user's reward that will be used to cook. 
    /// However, this locked amount can be claim in one exeption where user getReward during Fund state.
    /// See more detail in `getReward`
    function earnedLocked(address account) public view returns (uint256) {
        uint256 totalLockedReward = masterChef.pendingCake(pid, address(this)) + cake.balanceOf(address(this));

        uint256 userEarnedLockedReward;
        uint256 rewardsShare;
        uint256 totalShare;
        if (account == address(this)){
            rewardsShare = _shareTotal();
        } else {
            rewardsShare = _share(account);
        }
        if (rewardsShare > 0) {
            totalShare = _shareTotal();
            userEarnedLockedReward = totalLockedReward * _share(account) / _shareTotal();
        }
        return userEarnedLockedReward;
    }

    /* ========== MUTATIVE FUNCTIONS ========== */


    function _stake(address staker, uint256 lpAmount) internal override {
        if (userInfo[staker].amount == 0 && userInfo[staker].accruedReward == 0) {
            // If the staker is staking for the first time, set his last get reward period to current period
            stakerLastGetRewardPeriod[staker] = period;
        }
        super._stake(staker, lpAmount);
    }

    /// @notice Taken token0 or token1 in, convert half to the other token, provide liquidity and stake
    /// the LP tokens into MasterChef. Leftover token0 or token1 will be returned to msg.sender.
    /// Note that if user stake when contract in Lock state. The stake will be transfered to TempStakeManager contract
    /// and accrue rewards there. Operator need to transfer users' stake from TempStakeManager contract after
    /// contract enters Fund state.
    /// @param isToken0 Determine if token0 is the token msg.sender going to use for staking, token1 otherwise
    /// @param amount Amount of token0 or token1 to stake
    /// @param minReceivedTokenAmountSwap Minimum amount of token0 or token1 received when swapping one for the other
    /// @param minToken0AmountAddLiq The minimum amount of token0 received when adding liquidity
    /// @param minToken1AmountAddLiq The minimum amount of token1 received when adding liquidity
    function stake(
        bool isToken0,
        uint256 amount,
        uint256 minReceivedTokenAmountSwap,
        uint256 minToken0AmountAddLiq,
        uint256 minToken1AmountAddLiq
    ) public override nonReentrant notPaused updateReward(msg.sender) {
        uint256 lpAmount = _convertAndAddLiquidity(isToken0, true, amount, minReceivedTokenAmountSwap, minToken0AmountAddLiq, minToken1AmountAddLiq);

        if (state == State.Fund) {
            _stake(msg.sender, lpAmount);
        } else {
            // If it's in Lock state, transfer LP to TempStakeManager
            lp.transfer(address(tempStakeManager), lpAmount);
            tempStakeManager.stake(msg.sender, lpAmount);
        }
    }

    /// @notice Take LP tokens and stake into MasterChef contract.
    /// @param lpAmount Amount of LP tokens to stake
    function stakeWithLP(uint256 lpAmount) public override nonReentrant notPaused updateReward(msg.sender) {
        lp.safeTransferFrom(msg.sender, address(this), lpAmount);

        if (state == State.Fund) {
            _stake(msg.sender, lpAmount);
        } else {
            // If it's in Lock state, transfer LP to TempStakeManager
            lp.transfer(address(tempStakeManager), lpAmount);
            tempStakeManager.stake(msg.sender, lpAmount);
        }

    }

    /// @notice Take native tokens, convert to wrapped native tokens and stake into MasterChef contract.
    /// @param minReceivedTokenAmountSwap Minimum amount of token0 or token1 received when swapping one for the other
    /// @param minToken0AmountAddLiq The minimum amount of token0 received when adding liquidity
    /// @param minToken1AmountAddLiq The minimum amount of token1 received when adding liquidity
    function stakeWithNative(
        uint256 minReceivedTokenAmountSwap,
        uint256 minToken0AmountAddLiq,
        uint256 minToken1AmountAddLiq
    ) public payable override nonReentrant notPaused updateReward(msg.sender) {
        require(msg.value > 0, "No native tokens sent");
        (address NATIVE_TOKEN, bool isToken0) = _validateIsNativeToken();

        IWETH(NATIVE_TOKEN).deposit{ value: msg.value }();
        uint256 lpAmount = _convertAndAddLiquidity(isToken0, false, msg.value, minReceivedTokenAmountSwap, minToken0AmountAddLiq, minToken1AmountAddLiq);

        if (state == State.Fund) {
            _stake(msg.sender, lpAmount);
        } else {
            // If it's in Lock state, transfer LP to TempStakeManager
            lp.transfer(address(tempStakeManager), lpAmount);
            tempStakeManager.stake(msg.sender, lpAmount);
        }
    }

    function getReward(uint256 minToken0AmountConverted, uint256 minToken1AmountConverted, uint256 minBCNTAmountConverted) public override {
        revert("This function is not available");
    }

    /// @notice Transfer BCNT to user according to his share
    /// During Lock state, liquidity provider need to front the rewards user is trying to get, so a portion of rewards
    /// , i.e., penalty,  will be confiscated and paid to liquiditiy provider.
    /// @param minBCNTAmountConverted The minimum amount of BCNT received swapping Cake for BCNT
    /// @param getMasterChefReward True indicates that user also gets reward out from MasterChef
    function getReward(uint256 minBCNTAmountConverted, bool getMasterChefReward) public updateReward(msg.sender) {
        require(stakerLastGetRewardPeriod[msg.sender] < period, "Already getReward in this period");
      
        uint256 reward = userInfo[msg.sender].accruedReward;
        if (reward > 0) {
            uint256 totalReward = userInfo[address(this)].accruedReward;
            // If user getReward during Lock state, he only gets part of reward
            uint256 actualReward;
            if (state == State.Fund) {
                actualReward = reward;
            } else {
                actualReward = reward * (100 - penaltyPercentage) / 100;
            }
            // bonusShare: based on user's reward and totalReward,
            // determine how many bonus can user take away.
            // NOTE: totalReward = userInfo[address(this)].accruedReward;
            uint256 bonusShare = bonus * actualReward / totalReward;

            // Update records:
            userInfo[msg.sender].accruedReward = 0;
            // Add (reward - actualReward) to liquidity provider's rewards
            userInfo[liquidityProvider].accruedReward = userInfo[liquidityProvider].accruedReward + (reward - actualReward);
            // substract user's rewards from totalReward
            userInfo[address(this)].accruedReward = (totalReward - actualReward);
            // substract bonusShare from bonus
            bonus = (bonus - bonusShare);

            // If user getReward during Lock state, transfer from liquidityProvider to front the rewards
            if (state == State.Lock) {
                IERC20(BCNT).safeTransferFrom(liquidityProvider, address(this), bonusShare);
            }

            // If user getReward during Fund state and also wants to get MasterChef reward out
            if (state == State.Fund && getMasterChefReward) {
                // Get reward from MasterChef by performing a no-op
                masterChef.deposit(pid, 0);
                uint256 masterChefReward = cake.balanceOf(address(this)) * actualReward / totalReward;
                uint256 convertedAmount = _convertCakeToBCNT(masterChefReward, minBCNTAmountConverted);
                bonusShare += convertedAmount;
                emit MasterChefReward(masterChefReward);
            }

            IERC20(BCNT).safeTransfer(msg.sender, bonusShare);
            stakerLastGetRewardPeriod[msg.sender] = period;
            emit RewardPaid(msg.sender, bonusShare);
        }
    }

    /// @notice Withdraw all stake from MasterChef, remove liquidity, get the reward out and convert one asset to another.
    /// @param minToken0AmountConverted The minimum amount of token0 received when removing liquidity
    /// @param minToken1AmountConverted The minimum amount of token1 received when removing liquidity
    /// @param minBCNTAmountConverted The minimum amount of BCNT received swapping Cake for BCNT
    /// @param token0Percentage Determine what percentage of token0 to return to user. Any number between 0 to 100
    function exit(
        uint256 minToken0AmountConverted,
        uint256 minToken1AmountConverted,
        uint256 minBCNTAmountConverted,
        uint256 token0Percentage
    ) external override {
        withdraw(minToken0AmountConverted, minToken1AmountConverted, token0Percentage, userInfo[msg.sender].amount);
        getReward(minBCNTAmountConverted, true);
        tempStakeManager.abort(msg.sender, minBCNTAmountConverted);
    }

    function exitWithLP(uint256 minToken0AmountConverted, uint256 minToken1AmountConverted, uint256 minBCNTAmountConverted) external override {
        revert("This function is not available");
    }

    /// @notice Withdraw all stake from MasterChef, remove liquidity, get the reward out and convert one asset to another.
    /// @param minBCNTAmountConverted The minimum amount of BCNT received swapping Cake for BCNT
    function exitWithLP(uint256 minBCNTAmountConverted) external {
        withdrawWithLP(userInfo[msg.sender].amount);
        getReward(minBCNTAmountConverted, true);
        tempStakeManager.abort(msg.sender, minBCNTAmountConverted);
    }

    function exitWithNative(uint256 token0Percentage, uint256 minToken0AmountConverted, uint256 minToken1AmountConverted, uint256 minTokenAmountConverted) external override {
        revert("This function is not available");
    }

    /// @notice Withdraw all stake from MasterChef, remove liquidity, get the reward out and convert one asset to another
    /// @param minToken0AmountConverted The minimum amount of token0 received when removing liquidity
    /// @param minToken1AmountConverted The minimum amount of token1 received when removing liquidity
    /// @param minBCNTAmountConverted The minimum amount of BCNT received swapping Cake for BCNT
    function exitWithNative(
        uint256 minToken0AmountConverted,
        uint256 minToken1AmountConverted,
        uint256 minBCNTAmountConverted
    ) external {
        withdrawWithNative(minToken0AmountConverted, minToken1AmountConverted, userInfo[msg.sender].amount);
        getReward(minBCNTAmountConverted, true);
        tempStakeManager.abort(msg.sender, minBCNTAmountConverted);
    }


    /* ========== RESTRICTED FUNCTIONS ========== */

    /// @notice Transfer users' stake from TempStakeManager contract back to this contract.
    /// @param stakerIndex Index of the staker to transfer his stake from TempStakeManager contract
    function transferStake(uint256 stakerIndex, ITempStakeManagerCakeFarm.minAmountVars memory minAmounts) external onlyOperator notLocked {
        address staker = tempStakeManager.getStakerAt(stakerIndex);
        _updateRewardBefore(staker);

        (uint256 lpAmount, uint256 convertedLPAmount) = tempStakeManager.exit(staker, minAmounts);
        uint256 stakingLPAmount = lpAmount + convertedLPAmount;
        _stake(staker, stakingLPAmount);
        _updateRewardAfter(staker);
    }

    /// @notice Instruct TempStakeManager contract to exit the user: return LP tokens and rewards to user.
    /// @param stakers List of stakers to exit
    /// @param minBCNTAmounts List of minimum amount of BCNT received swapping Cake for BCNT
    function abortFromTempStakeManager(address[] calldata stakers, uint256[] calldata minBCNTAmounts) external onlyOperator {
        for (uint256 i = 0; i < stakers.length; i++) {
            address staker = stakers[i];
            tempStakeManager.abort(staker, minBCNTAmounts[i]);
        }
    }

    /// @notice getReward function for liquidity provider. Liquidity provider is not subject to the penalty
    /// when getReward during Lock state. Liquidity provider will earn rewards because the penalty user paid
    /// goes to liquidity provider.
    function liquidityProviderGetBonus() external nonReentrant onlyLiquidityProvider updateReward(liquidityProvider) {
        uint256 lpRewardsShare = userInfo[liquidityProvider].accruedReward;
        if (lpRewardsShare > 0) {
            uint256 totalReward = userInfo[address(this)].accruedReward;
            uint256 lpBonusShare = bonus * lpRewardsShare / totalReward;

            userInfo[liquidityProvider].accruedReward = 0;
            userInfo[address(this)].accruedReward = (totalReward - lpRewardsShare);
            bonus = (bonus - lpBonusShare);

            IERC20(BCNT).safeTransfer(liquidityProvider, lpBonusShare);

            emit RewardPaid(liquidityProvider, lpBonusShare);
        }
    }

    /// @notice Get all reward out from MasterChef contract and transfer them to
    /// operator so operator can invest them.
    /// @param minBCNTAmountConverted The minimum amount of BCNT received swapping Cake for BCNT
    function cook(uint256 minBCNTAmountConverted) external nonReentrant notLocked onlyOperator {
        // Get reward from MasterChef by performing a no-op
        masterChef.deposit(pid, 0);
        uint256 cakeLeft = cake.balanceOf(address(this));
        _convertCakeToBCNT(cakeLeft, minBCNTAmountConverted);
        // Transfer all BCNT to operator
        uint256 allRewards = IERC20(BCNT).balanceOf(address(this));
        IERC20(BCNT).safeTransfer(operator, allRewards);

        state = State.Lock;

        emit Cook(allRewards);
    }

    /// @notice Opreator returns reward.
    function serve(uint256 amount) external nonReentrant locked onlyOperator {
        // Transfer BCNT from operator
        IERC20(BCNT).safeTransferFrom(operator, address(this), amount);

        bonus = amount;
        state = State.Fund;
        period += 1;

        emit Serve(amount);
    }

    function _convertCakeToBCNT(uint256 cakeLeft, uint256 minBCNTAmountConverted) internal returns (uint256) {
        // Convert Cake to BCNT
        uint256 balBefore = IERC20(BCNT).balanceOf(address(this));
        cake.safeApprove(address(converter), cakeLeft);
        converter.convert(address(cake), cakeLeft, 100, BCNT, minBCNTAmountConverted, address(this));
        uint256 convertedAmount = IERC20(BCNT).balanceOf(address(this)) - balBefore;

        return convertedAmount;
    }

    /// @notice Get cake from MasterChef plus remaining cake on this contract and convert cake to BCNT
    /// @param minBCNTAmountConverted The minimum amount of BCNT received swapping Cake for BCNT
    function compound(uint256 minBCNTAmountConverted) external nonReentrant updateReward(address(0)) onlyOperator {
        // Get reward from MasterChef by performing a no-op
        masterChef.deposit(pid, 0);
        uint256 cakeLeft = cake.balanceOf(address(this));
        if (cakeLeft > 0) {
            _convertCakeToBCNT(cakeLeft, minBCNTAmountConverted);
        }
    }

    function updateOperator(address newOperator) external onlyOwner {
        operator = newOperator;

        emit UpdateOperator(newOperator);
    }

    function updateLiquidityProvider(address newLiquidityProvider) external onlyOwner {
        _updateRewardBefore(liquidityProvider);
        _updateRewardBefore(newLiquidityProvider);

        userInfo[newLiquidityProvider].accruedReward += userInfo[liquidityProvider].accruedReward;
        userInfo[liquidityProvider].accruedReward = 0;
        liquidityProvider = newLiquidityProvider;

        _updateRewardAfter(liquidityProvider);
        _updateRewardAfter(newLiquidityProvider);
    }

    function setPenaltyPercentage(uint256 newPenaltyPercentage) external onlyOperator {
        require((newPenaltyPercentage >= 0) && (newPenaltyPercentage <= 100), "Invalid penalty percentage");
        penaltyPercentage = newPenaltyPercentage;
    }

    /* ========== MODIFIERS ========== */

    modifier notLocked() {
        require(state == State.Fund, "Contract is in locked state");
        _;
    }

    modifier locked() {
        require(state == State.Lock, "Contract is not in locked state");
        _;
    }

    modifier onlyOperator() {
        require(msg.sender == operator, "Only the contract operator may perform this action");
        _;
    }

    modifier onlyLiquidityProvider() {
        require(msg.sender == liquidityProvider, "Only the contract liquidity provider may perform this action");
        _;
    }

    /* ========== EVENTS ========== */

    event Compounded(uint256 lpAmount);
    event Cook(uint256 rewardAmount);
    event Serve(uint256 rewardAmount);
    event MasterChefReward(uint256 amount);
    event RewardPaid(address indexed user, uint256 reward);
    event UpdateOperator(address newOperator);
}