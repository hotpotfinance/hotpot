pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./BaseSingleTokenStaking.sol";
import "./IPancakeRouter.sol";
import "./ITempStakeManager.sol";

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
        isToken0RewardsToken = (stakingRewards.rewardsToken() == address(token0));

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

    /* ========== MUTATIVE FUNCTIONS ========== */

    function _getRewardToken() internal view returns (IERC20 rewardToken) {
        if (isToken0RewardsToken) {
            rewardToken = token0;
        } else {
            rewardToken = token1;
        }
    }

    /// @notice Taken token0 or token1 in, convert half to the other token, provide liquidity and stake
    /// the LP tokens into StakingRewards. Leftover token0 or token1 will be returned to msg.sender.
    /// Note that if user stake when contract in Lock state. The stake will be transfered to TempStakeManager contract
    /// and accrue rewards there. Operator need to transfer users' stake from TempStakeManager contract after
    /// contract enters Fund state.
    /// @param isToken0 Determine if token0 is the token msg.sender going to use for staking, token1 otherwise
    /// @param amount Amount of token0 or token1 to stake
    function stake(bool isToken0, uint256 amount) public override nonReentrant notPaused updateReward(msg.sender) {
        uint256 lpAmount = _convertAndAddLiquidity(isToken0, amount);

        if (state == State.Fund) {
            lp.safeApprove(address(stakingRewards), lpAmount);
            stakingRewards.stake(lpAmount);
            _totalSupply = _totalSupply + lpAmount;
            _balances[msg.sender] = _balances[msg.sender] + lpAmount;
            emit Staked(msg.sender, lpAmount);
        } else {
            // If it's in Lock state, transfer LP to TempStakeManager
            lp.transfer(address(tempStakeManager), lpAmount);
            tempStakeManager.stake(msg.sender, lpAmount);
        }
    }

    /// @notice Withdraw stake from StakingRewards, remove liquidity and convert one asset to another.
    /// @param token0Percentage Determine what percentage of token0 to return to user. Any number between 0 to 100
    /// @param amount Amount of stake to withdraw
    function withdraw(uint256 token0Percentage, uint256 amount) public override nonReentrant updateReward(msg.sender) {
        require(amount > 0, "Cannot withdraw 0");

        // Update records:
        // substract withdrawing LP amount from total LP amount staked
        _totalSupply = (_totalSupply - amount);
        // substract withdrawing LP amount from user's balance
        _balances[msg.sender] = (_balances[msg.sender] - amount);

        // Withdraw
        stakingRewards.withdraw(amount);

        lp.safeApprove(address(converter), amount);
        converter.removeLiquidityAndConvert(IPancakePair(address(lp)), amount, token0Percentage, msg.sender);

        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Get the reward out and convert one asset to another. Note that reward token is either token0 or token1.
    /// During Lock state, liquidity provider need to front the rewards user is trying to get, so a portion of rewards
    /// , i.e., penalty,  will be confiscated and paid to liquiditiy provider.
    /// @param token0Percentage Determine what percentage of token0 to return to user. Any number between 0 to 100
    function getReward(uint256 token0Percentage) override public updateReward(msg.sender) {        
        uint256 reward = _rewards[msg.sender];
        uint256 totalReward = _rewards[address(this)];
        if (reward > 0) {
            // If user withdraw during Lock state, he only gets part of reward
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

            (IERC20 rewardToken, IERC20 otherToken) = isToken0RewardsToken ? (token0, token1) : (token1, token0);
            // Transfer from liquidityProvider to front the rewards if user withdraw during Lock state
            if (state == State.Lock) {
                rewardToken.safeTransferFrom(liquidityProvider, address(this), bonusShare);
            }

            rewardToken.safeApprove(address(converter), bonusShare);
            uint256 convertPercentage = isToken0RewardsToken ? 100 - token0Percentage : token0Percentage;
            converter.convert(address(rewardToken), bonusShare, convertPercentage, address(otherToken), 0, msg.sender);
            emit RewardPaid(msg.sender, bonusShare);
        }
    }

    /// @notice Withdraw all stake from StakingRewards, remove liquidity, get the reward out and convert one asset to another.
    /// @param token0Percentage Determine what percentage of token0 to return to user. Any number between 0 to 100
    function exit(uint256 token0Percentage) external override {
        withdraw(token0Percentage, _balances[msg.sender]);
        getReward(token0Percentage);
        tempStakeManager.abort(msg.sender);
    }

    /* ========== RESTRICTED FUNCTIONS ========== */

    /// @notice Transfer users' stake from TempStakeManager contract back to this contract.
    /// @param numStakersToProcess Number of stakers to transfer their stakes from TempStakeManager contract
    function transferStake(uint256 numStakersToProcess) external onlyOperator notLocked {
        address[] memory stakerList = tempStakeManager.getStakersUpto(numStakersToProcess);
        for (uint256 i = 0; i < numStakersToProcess; i++) {
            address staker = stakerList[i];
            _updateReward(staker);

            (uint256 lpAmount, uint256 convertedLPAmount) = tempStakeManager.exit(staker);
            uint256 stakingLPAmount = lpAmount + convertedLPAmount;
            // Add the balance to user balance and total supply
            _totalSupply = _totalSupply + stakingLPAmount;
            _balances[staker] = _balances[staker] + stakingLPAmount;
            lp.safeApprove(address(stakingRewards), stakingLPAmount);
            stakingRewards.stake(stakingLPAmount);
            emit Staked(staker, stakingLPAmount);
        }
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

            IERC20 rewardToken = _getRewardToken();
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
        IERC20 rewardToken = _getRewardToken();
        uint256 allRewards = rewardToken.balanceOf(address(this));
        rewardToken.safeTransfer(operator, allRewards);

        state = State.Lock;

        emit Cook(allRewards);
    }

    /// @notice Opreator returns reward.
    function serve(uint256 amount) external nonReentrant locked onlyOperator {
        // Transfer reward from operator
        IERC20 rewardToken = _getRewardToken();
        rewardToken.safeTransferFrom(operator, address(this), amount);

        bonus = amount;
        state = State.Fund;

        emit Serve(amount);
    }

    function updateOperator(address newOperator) external onlyOwner {
        operator = newOperator;
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

    event RewardPaid(address indexed user, uint256 reward);
    event Cook(uint256 rewardAmount);
    event Serve(uint256 rewardAmount);
}