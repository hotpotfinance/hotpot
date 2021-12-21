pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./BaseSingleTokenStaking.sol";
import "./IPancakeRouter.sol";
import "./ITempStakeManager.sol";
import "./IWeth.sol";

/// @title A wrapper contract over StakingRewards contract that allows single asset in/out,
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
contract Bet is BaseSingleTokenStaking {
    using SafeERC20 for IERC20;

    enum State { Fund, Lock }

    /* ========== STATE VARIABLES ========== */

    State state;
    uint256 public bonus;
    address public operator;
    address public liquidityProvider;
    IPancakeRouter public router;
    ITempStakeManager public tempStakeManager;
    uint256 public penaltyPercentage;
    uint256 public rewardBeforeCook;
    uint256 public period;
    mapping(address => uint256) public stakerLastGetRewardPeriod;

    /* ========== CONSTRUCTOR ========== */

    function initialize(
        string memory _name,
        address _owner,
        IPancakePair _lp,
        IConverter _converter,
        IStakingRewards _stakingRewards,
        address _operator,
        address _liquidityProvider,
        IPancakeRouter _router,
        ITempStakeManager _tempStakeManager,
        uint256 _penaltyPercentage
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

        period = 1;
        state = State.Fund;
        operator = _operator;
        liquidityProvider = _liquidityProvider;
        router = _router;
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
        uint256 rewardPerToken = stakingRewards.rewardPerToken();
        return (_balances[account] * (rewardPerToken - _userRewardPerTokenPaid[account]) / (1e18)) + _rewards[account];
    }

    /// @notice Get the total reward share in this contract.
    /// @notice Total reward is tracked with `_rewards[address(this)]` and `_userRewardPerTokenPaid[address(this)]`
    function _shareTotal() public view returns (uint256) {
        uint256 rewardPerToken = stakingRewards.rewardPerToken();
        return (_totalSupply * (rewardPerToken - _userRewardPerTokenPaid[address(this)]) / (1e18)) + _rewards[address(this)];
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
        uint256 rewardsLeft = stakingRewards.earned(address(this));
        uint256 totalLockedReward = rewardBeforeCook + rewardsLeft;

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

    function _stake(address staker, uint256 lpAmount) internal {
        if (_balances[staker] == 0 && _rewards[staker] == 0) {
            // If the staker is staking for the first time, set his last get reward period to current period
            stakerLastGetRewardPeriod[staker] = period;
        }
        lp.safeApprove(address(stakingRewards), lpAmount);
        stakingRewards.stake(lpAmount);
        _totalSupply = _totalSupply + lpAmount;
        _balances[staker] = _balances[staker] + lpAmount;
        emit Staked(staker, lpAmount);
    }

    /// @notice Taken token0 or token1 in, convert half to the other token, provide liquidity and stake
    /// the LP tokens into StakingRewards. Leftover token0 or token1 will be returned to msg.sender.
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

    /// @notice Take LP tokens and stake into StakingRewards contract.
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

        if (state == State.Fund) {
            _stake(msg.sender, lpAmount);
        } else {
            // If it's in Lock state, transfer LP to TempStakeManager
            lp.transfer(address(tempStakeManager), lpAmount);
            tempStakeManager.stake(msg.sender, lpAmount);
        }
    }

    /// @notice Override and intentionally failing the inherited getReward function
    function getReward(uint256 token0Percentage, uint256 minTokenAmountConverted) public override {
        revert("This function is not available");
    }

    /// @notice Get the reward out and see if reward token is one of token0 or token1, if so, convert one asset to another.
    /// If reward token is neither one of them, transfer reward directly to user.
    /// During Lock state, liquidity provider need to front the rewards user is trying to get, so a portion of rewards
    /// , i.e., penalty,  will be confiscated and paid to liquiditiy provider.
    /// @param token0Percentage Determine what percentage of token0 to return to user. Any number between 0 to 100
    /// @param minTokenAmountConverted The minimum amount of token0 or token1 received when converting reward token to either one of them
    /// @param getStakingRewardsReward True indicates that user also gets reward out from StakingRewards
    function getReward(uint256 token0Percentage, uint256 minTokenAmountConverted, bool getStakingRewardsReward) public updateReward(msg.sender) { 
        require(stakerLastGetRewardPeriod[msg.sender] < period, "Already getReward in this period"); 
      
        uint256 reward = _rewards[msg.sender];
        uint256 totalReward = _rewards[address(this)];
        if (reward > 0) {
            // If user getReward during Lock state, he only gets part of reward
            uint256 actualReward;
            if (state == State.Fund) {
                actualReward = reward;
            } else {
                actualReward = reward * (100 - penaltyPercentage) / 100;
            }
            // bonusShare: based on user's reward and totalReward,
            // determine how many bonus can user take away.
            // NOTE: totalReward = _rewards[address(this)];
            uint256 bonusShare = bonus * actualReward / totalReward;

            // Update records:
            _rewards[msg.sender] = 0;
            // Add (reward - actualReward) to liquidity provider's rewards
            _rewards[liquidityProvider] = _rewards[liquidityProvider] + (reward - actualReward);
            // substract user's rewards from totalReward
            _rewards[address(this)] = (totalReward - actualReward);
            // substract bonusShare from bonus
            bonus = (bonus - bonusShare);

            IERC20 rewardToken = IERC20(stakingRewards.rewardsToken());
            // If user getReward during Lock state, transfer from liquidityProvider to front the rewards
            if (state == State.Lock) {
                rewardToken.safeTransferFrom(liquidityProvider, address(this), bonusShare);
            }

            // If user getReward during Fund state, 
            if (state == State.Fund && getStakingRewardsReward) {
                uint256 rewardsLeft = stakingRewards.earned(address(this));
                if (rewardsLeft > 0) {
                    rewardBeforeCook += rewardsLeft;
                    stakingRewards.getReward();
                    uint256 stakingRewardsReward = rewardBeforeCook * actualReward / totalReward;
                    bonusShare += stakingRewardsReward;
                    rewardBeforeCook -= stakingRewardsReward;
                    emit StakingRewardsReward(stakingRewardsReward);
                }
            }

            if (rewardToken == token0 || rewardToken == token1) {
                IERC20 otherToken = rewardToken == token0 ? token1 : token0;
                rewardToken.safeApprove(address(converter), bonusShare);
                uint256 convertPercentage = isToken0RewardsToken ? 100 - token0Percentage : token0Percentage;
                converter.convert(address(rewardToken), bonusShare, convertPercentage, address(otherToken), minTokenAmountConverted, msg.sender);
            } else {
                rewardToken.safeTransfer(msg.sender, bonusShare);
            }

            stakerLastGetRewardPeriod[msg.sender] = period;
            emit RewardPaid(msg.sender, bonusShare);
        }
    }

    /// @notice Withdraw all stake from StakingRewards, remove liquidity, get the reward out and convert one asset to another.
    /// @param minTokenAmountConverted The minimum amount of token0 or token1 received when converting reward token to either one of them
    /// @param minToken0AmountConverted The minimum amount of token0 received when removing liquidity
    /// @param minToken1AmountConverted The minimum amount of token1 received when removing liquidity
    /// @param token0Percentage Determine what percentage of token0 to return to user. Any number between 0 to 100
    function exit(uint256 minTokenAmountConverted, uint256 minToken0AmountConverted, uint256 minToken1AmountConverted, uint256 token0Percentage) external override {
        withdraw(minToken0AmountConverted, minToken1AmountConverted, token0Percentage, _balances[msg.sender]);
        getReward(token0Percentage, minTokenAmountConverted, true);
        tempStakeManager.abort(msg.sender);
    }

    /// @notice Withdraw all stake from StakingRewards, remove liquidity, get the reward out and convert one asset to another.
    /// @param token0Percentage Determine what percentage of token0 to return to user. Any number between 0 to 100
    /// @param minTokenAmountConverted The minimum amount of token0 or token1 received when converting reward token to either one of them
    function exitWithLP(uint256 token0Percentage, uint256 minTokenAmountConverted) external override {
        withdrawWithLP(_balances[msg.sender]);
        getReward(token0Percentage, minTokenAmountConverted, true);
        tempStakeManager.abort(msg.sender);
    }

    /* ========== RESTRICTED FUNCTIONS ========== */

    /// @notice Transfer users' stake from TempStakeManager contract back to this contract.
    /// @param stakerIndex Index of the staker to transfer his stake from TempStakeManager contract
    function transferStake(uint256 stakerIndex, ITempStakeManager.minAmountVars memory minAmounts) external onlyOperator notLocked {
        address staker = tempStakeManager.getStakerAt(stakerIndex);
        _updateReward(staker);

        (uint256 lpAmount, uint256 convertedLPAmount) = tempStakeManager.exit(staker, minAmounts);
        uint256 stakingLPAmount = lpAmount + convertedLPAmount;
        _stake(staker, stakingLPAmount);
    }

    /// @notice Instruct TempStakeManager contract to exit the user: return LP tokens and rewards to user.
    /// @param stakers List of stakers to exit
    function abortFromTempStakeManager(address[] calldata stakers) external onlyOperator {
        for (uint256 i = 0; i < stakers.length; i++) {
            address staker = stakers[i];
            tempStakeManager.abort(staker);
        }
    }

    /// @notice getReward function for liquidity provider. Liquidity provider is not subject to the penalty
    /// when getReward during Lock state. Liquidity provider will earn rewards because the penalty user paid
    /// goes to liquidity provider.
    function liquidityProviderGetBonus() external nonReentrant onlyLiquidityProvider updateReward(liquidityProvider) {
        uint256 lpRewardsShare = _rewards[liquidityProvider];
        if (lpRewardsShare > 0) {
            uint256 lpBonusShare = bonus * lpRewardsShare / _rewards[address(this)];

            _rewards[liquidityProvider] = 0;
            _rewards[address(this)] = (_rewards[address(this)] - lpRewardsShare);
            bonus = (bonus - lpBonusShare);

            IERC20 rewardToken = IERC20(stakingRewards.rewardsToken());
            rewardToken.safeTransfer(liquidityProvider, lpBonusShare);

            emit RewardPaid(liquidityProvider, lpBonusShare);
        }
    }

    /// @notice Get all reward out from StakingRewards contract and transfer them to
    /// operator so operator can invest them.
    function cook() external nonReentrant notLocked onlyOperator {
        // Get this contract's reward from StakingRewards
        uint256 rewardsLeft = stakingRewards.earned(address(this));
        if (rewardsLeft > 0) {
            stakingRewards.getReward();
        }
        // Transfer all rewards to operator
        IERC20 rewardToken = IERC20(stakingRewards.rewardsToken());
        uint256 allRewards = rewardToken.balanceOf(address(this));
        rewardToken.safeTransfer(operator, allRewards);

        rewardBeforeCook = 0;
        state = State.Lock;

        emit Cook(allRewards);
    }

    /// @notice Opreator returns reward.
    function serve(uint256 amount) external nonReentrant locked onlyOperator {
        // Transfer reward from operator
        IERC20 rewardToken = IERC20(stakingRewards.rewardsToken());
        rewardToken.safeTransferFrom(operator, address(this), amount);

        bonus = amount;
        state = State.Fund;
        period += 1;

        emit Serve(amount);
    }

    function updateOperator(address newOperator) external onlyOwner {
        operator = newOperator;

        emit UpdateOperator(newOperator);
    }

    function updateLiquidityProvider(address newLiquidityProvider) external onlyOwner {
        _updateReward(liquidityProvider);
        _updateReward(newLiquidityProvider);
        _rewards[newLiquidityProvider] += _rewards[liquidityProvider];
        _rewards[liquidityProvider] = 0;
        liquidityProvider = newLiquidityProvider;
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

    function _updateReward(address account) internal {
        uint256 rewardPerTokenStored = stakingRewards.rewardPerToken();
        if (account != address(0)) {
            _rewards[account] = _share(account);
            _userRewardPerTokenPaid[account] = rewardPerTokenStored;

            // Use _rewards[address(this)] to keep track of rewards earned by all accounts.
            // NOTE: it does not count into the accrued reward because accrued reward
            // are periodically invested somewhere else and user will be rewarded with
            // returned accrued rewards plus profit.
            _rewards[address(this)] = _shareTotal();
            _userRewardPerTokenPaid[address(this)] = rewardPerTokenStored;
        }
    }

    modifier updateReward(address account) override {
        _updateReward(account);
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

    event StakingRewardsReward(uint256 amount);
    event RewardPaid(address indexed user, uint256 reward);
    event Cook(uint256 rewardAmount);
    event Serve(uint256 rewardAmount);
    event UpdateOperator(address newOperator);
}