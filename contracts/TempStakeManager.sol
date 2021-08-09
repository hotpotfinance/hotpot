pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./BaseSingleTokenStaking.sol";
import "./IPancakeRouter.sol";

/// @title A contract for temporarily managin stake for users. 
/// @notice When main contract calls `stake`, it receives LP token from main contract and stake it.
/// When main contract calls `exit`, it withdraws stake, get reward and convert reward to LP token
/// and transfer LP token to main contract.
contract TempStakeManager is BaseSingleTokenStaking {
    using SafeERC20 for IERC20;

    /* ========== STATE VARIABLES ========== */

    address public mainContract;
    address[] private _stakerList;
    uint256 public numStaker;

    /* ========== CONSTRUCTOR ========== */

    function initialize(
        string memory _name,
        address _owner,
        address _converter,
        address _stakingRewards,
        address _mainContract
    ) external {
        require(keccak256(abi.encodePacked(name)) == keccak256(abi.encodePacked("")), "Already initialized");
        super.initializePausable(_owner);
        super.initializeReentrancyGuard();

        name = _name;
        converter = IConverter(_converter);
        lp = IERC20(converter.lp());
        token0 = IERC20(converter.token0());
        token1 = IERC20(converter.token1());
        stakingRewards = IStakingRewards(_stakingRewards);
        isToken0RewardsToken = (stakingRewards.rewardsToken() == address(token0));

        mainContract = _mainContract;
    }

    /* ========== VIEWS ========== */

    /// @dev Get the reward earned by specified account
    function getStakerList() public view returns (address[] memory) {
        address[] memory stakerList = new address[](numStaker);
        for (uint256 i = 0; i < numStaker; i++) {
            stakerList[i] = (_stakerList[i]);
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
    function stake(bool isToken0, uint256 amount) public override {
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

        numStaker ++;
        _stakerList.push(staker);
        emit Staked(staker, lpAmount);
    }

    /// @notice Override and intentionally failing the normal withdraw function
    function withdraw(uint256 token0Percentage, uint256 amount) public override {
        revert("This function is not available");
    }

    /// @notice Override and intentionally failing the normal exit function
    function exit(uint256 token0Percentage) public override {
        revert("This function is not available");
    }

    /// @notice Withdraw stake from StakingRewards, get the reward out and convert reward to LP token
    /// and transfer LP token to main contract.
    /// @param staker Account that is staking
    /// @return lpAmount Amount of LP token withdrawn
    /// @return convertedLPAmount Amount of LP token converted from reward
    function exit(address staker) external onlyMainContract nonReentrant updateReward(staker) returns (uint256 lpAmount, uint256 convertedLPAmount) {
        lpAmount = _balances[staker];

        // Clean up staker's balance
        _totalSupply = _totalSupply - lpAmount;
        _balances[staker] = 0;
        // Withdraw stake
        stakingRewards.withdraw(lpAmount);

        // Get reward and convert to LP token
        stakingRewards.getReward();
        uint256 reward = _rewards[staker];
        if (reward > 0) {
            _rewards[staker] = 0;

            address rewardToken = isToken0RewardsToken ? address(token0) : address(token1);
            uint256 lpAmountBefore = lp.balanceOf(address(this));

            // Convert rewards to LP tokens
            IERC20(rewardToken).safeApprove(address(converter), reward);
            converter.convertAndAddLiquidity(rewardToken, reward, 0, address(this));

            uint256 lpAmountAfter = lp.balanceOf(address(this));
            convertedLPAmount = (lpAmountAfter - lpAmountBefore);
            emit ConvertedLP(staker, convertedLPAmount);
        }

        // Transfer withdrawn LP amount plus converted LP amount
        lp.transfer(mainContract, lpAmount + convertedLPAmount);
        emit Withdrawn(staker, lpAmount);
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
    }

    function clearStakerList() public onlyMainContract {
        delete _stakerList;
        numStaker = 0;
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