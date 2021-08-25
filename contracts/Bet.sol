pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./BaseSingleTokenStaking.sol";
import "./IPancakeRouter.sol";
import "./ITempStakeManager.sol";

/// @title A staking contract wrapper for single asset in/out, with operator periodically investing
/// accrued rewards and return them with profits.
/// @notice Asset tokens are token0 and token1. Staking token is the LP token of token0/token1.
/// User will be earning returned rewards plus profit
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
    IERC20 public cookToken;
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
        IERC20 _cookToken,
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
        cookToken = _cookToken;
        penaltyPercentage = _penaltyPercentage;
    }

    /* ========== VIEWS ========== */

    /// @dev Get the State of the contract
    function getState() public view returns (string memory) {
        if (state == State.Fund) return "Fund";
        else return "Lock";
    }

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

    /// @dev Get the bonus amount earned by specified account
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

    function _swap(uint256 _swapAmount, address _in, address _out, address _recipient) internal returns (uint256) {
        if (_swapAmount == 0) return 0;

        IERC20(_in).safeApprove(address(router), _swapAmount);

        address[] memory path = new address[](2);
        path[0] = _in;
        path[1] = _out;
        uint256[] memory amounts = router.swapExactTokensForTokens(
            _swapAmount,
            0,
            path,
            _recipient,
            block.timestamp + 60
        );
        return amounts[1]; // swapped amount
    }

    /// @notice Taken token0 or token1 in, convert half to the other token, provide liquidity and stake
    /// the lp tokens into StakingRewards. Leftover token0 or token1 will be returned to msg.sender.
    /// Can only stake when state is not in Lock state.
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
            // If it's in Lock state, transfer lp to TempStakeManager
            lp.transfer(address(tempStakeManager), lpAmount);
            tempStakeManager.stake(msg.sender, lpAmount);
        }
    }

    /// @notice Withdraw stake from StakingRewards, remove liquidity and convert one asset to another.
    /// If withdraw during Lock state, only part of the reward can be claimed.
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
        converter.removeLiquidityAndConvert(IPancakePair(address(lp)), amount, token0Percentage, msg.sender);

        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Get the reward out and convert one asset to another. Note that reward token is either token0 or token1
    /// @param token0Percentage Determine what percentage of token0 to return to user. Any number between 0 to 100
    function getReward(uint256 token0Percentage) public updateReward(msg.sender) {        
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

    /// @notice Withdraw all stake from StakingRewards, remove liquidity, get the reward out and convert one asset to another
    /// @param token0Percentage Determine what percentage of token0 to return to user. Any number between 0 to 100
    function exit(uint256 token0Percentage) external override {
        withdraw(token0Percentage, _balances[msg.sender]);
        getReward(token0Percentage);
        tempStakeManager.abort(msg.sender);
    }

    /* ========== RESTRICTED FUNCTIONS ========== */

    function transferStake(address[] calldata stakers) external onlyOperator notLocked {
        for (uint256 i = 0; i < stakers.length; i++) {
            address staker = stakers[i];
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
        tempStakeManager.clearStakerList();
    }

    function abortFromTempStakeManager(address[] calldata stakers) external onlyOperator {
        for (uint256 i = 0; i < stakers.length; i++) {
            address staker = stakers[i];
            tempStakeManager.abort(staker);
        }
    }

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

    /// @notice Get all reward out, swap them to cookToken and transfer to operator so
    /// operator can invest them in deritive products
    function cook() external nonReentrant notLocked onlyOperator {
        // Get this contract's reward from StakingRewards
        uint256 rewardsLeft = stakingRewards.earned(address(this));
        if (rewardsLeft > 0) {
            stakingRewards.getReward();

            // Swap reward to cookToken and transfer to operator
            uint256 cookTokenAmount = _swap(rewardsLeft, address(_getRewardToken()), address(cookToken), operator);

            state = State.Lock;

            emit Cook(rewardsLeft, cookTokenAmount);
        }
    }

    /// @notice Return cookToken along with profit and swap them to reward token
    function serve(uint256 cookTokenAmount) external nonReentrant locked onlyOperator {
        // Transfer cookToken from operator
        cookToken.safeTransferFrom(operator, address(this), cookTokenAmount);
        // Swap cookToken to reward
        uint256 rewardsAmount = _swap(cookTokenAmount, address(cookToken), address(_getRewardToken()), address(this));

        bonus = bonus + rewardsAmount;
        state = State.Fund;

        emit Serve(cookTokenAmount, rewardsAmount);
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
    event Cook(uint256 rewardAmount, uint256 cookTokenAmount);
    event Serve(uint256 cookTokenAmount, uint256 rewardAmount);
}