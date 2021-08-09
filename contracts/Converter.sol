pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import "./IPancakePair.sol";
import "./IPancakeRouter.sol";

contract Owned {
    using SafeERC20 for IERC20;

    address public owner;
    address public nominatedOwner;

    function initializeOwner(address _owner) internal {
        require(owner == address(0), "Already initialized");
        require(_owner != address(0), "Owner address cannot be 0");
        owner = _owner;
        emit OwnerChanged(address(0), _owner);
    }

    function nominateNewOwner(address _owner) external onlyOwner {
        nominatedOwner = _owner;
        emit OwnerNominated(_owner);
    }

    function acceptOwnership() external {
        require(msg.sender == nominatedOwner, "You must be nominated before you can accept ownership");
        emit OwnerChanged(owner, nominatedOwner);
        owner = nominatedOwner;
        nominatedOwner = address(0);
    }

    modifier onlyOwner {
        _onlyOwner();
        _;
    }

    function _onlyOwner() private view {
        require(msg.sender == owner, "Only the contract owner may perform this action");
    }

    event OwnerNominated(address newOwner);
    event OwnerChanged(address oldOwner, address newOwner);
}

contract Converter is Owned, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    string public name;
    IERC20 public lp;
    IERC20 public token0;
    IERC20 public token1;
    IPancakeRouter public router;

    function implementation() external view returns (address) {
        return _getImplementation();
    }

    function initialize(string memory _name, address _owner, IPancakePair _lp, IPancakeRouter _router) external {
        require(keccak256(abi.encodePacked(name)) == keccak256(abi.encodePacked("")), "Already initialized");
        super.initializeOwner(_owner);

        name = _name;
        lp = IERC20(address(_lp));
        token0 = IERC20(_lp.token0());
        token1 = IERC20(_lp.token1());
        router = _router;
    }

    function _getInAndOut(address _inTokenAddress) internal view returns (bool, IERC20, IERC20) {
        bool switched;
        IERC20 tokenIn;
        IERC20 tokenOut;
        if (_inTokenAddress == address(token0)) {
            switched = false;
            tokenIn = token0;
            tokenOut = token1;
        } else if (_inTokenAddress == address(token1)) {
            switched = true;
            tokenIn = token1;
            tokenOut = token0;
        } else {
            revert("Invalid token address");
        }
        return (switched, tokenIn, tokenOut);
    }

    function _swap(uint256 _swapAmount, uint256 _minReceiveAmount, address _in, address _out, address _recipient) internal returns (uint256) {
        if (_swapAmount == 0) return 0;

        IERC20(_in).safeApprove(address(router), _swapAmount);

        address[] memory path = new address[](2);
        path[0] = _in;
        path[1] = _out;
        uint256[] memory amounts = router.swapExactTokensForTokens(
            _swapAmount,
            _minReceiveAmount,
            path,
            _recipient,
            block.timestamp + 60
        );
        return amounts[1]; // swapped amount
    }

    /// @notice Convert specified amount of tokenIn to tokenOut and send both to recipient
    /// @param _inTokenAddress The address of tokenIn: token0 or token1
    /// @param _amount The amount of tokenIn
    /// @param _convertPercentage The percentage of tokenIn amount to convert
    /// @param _minReceiveAmount The minimum amount of tokenOut expected to receive
    /// @param _recipient The recipient address of tokenOut
    function convert(address _inTokenAddress, uint256 _amount, uint256 _convertPercentage, uint256 _minReceiveAmount, address _recipient) external {
        require((0 <= _convertPercentage) && (_convertPercentage <= 100), "Invalid convert percentage");

        (, IERC20 tokenIn, IERC20 tokenOut) = _getInAndOut(_inTokenAddress);

        // Transfer tokenIn from msg.sender
        tokenIn.safeTransferFrom(msg.sender, address(this), _amount);

        // Swap specified proportion of tokenIn for tokenOut
        uint256 swapAmount = _amount * _convertPercentage / 100;
        _swap(swapAmount, _minReceiveAmount, address(tokenIn), address(tokenOut), _recipient);

        // Return half of tokenIn
        tokenIn.safeTransfer(_recipient, (_amount - swapAmount));
    }

    function _addLiquidity(uint256 _amountADesired, uint256 _amountBDesired, address _to) internal {
        token0.safeApprove(address(router), _amountADesired);
        token1.safeApprove(address(router), _amountBDesired);

        router.addLiquidity(
            address(token0),
            address(token1),
            _amountADesired,
            _amountBDesired,
            0, // _amountAMin
            0, // _amountBMin
            _to,
            block.timestamp + 60
        );

        IERC20(token0).safeApprove(address(router), 0);
        IERC20(token1).safeApprove(address(router), 0);
    }

    /// @notice Convert half of tokenIn to tokenOut, add both to liquidity pool and send lp token to recipient.
    // Return leftover tokenIn and tokenOut to msg.sender
    /// @param _inTokenAddress The address of tokenIn: token0 or token1
    /// @param _amount The amount of tokenIn
    /// @param _minReceiveAmount The minimum amount of tokenOut expected to receive
    /// @param _recipient The recipient address of tokenOut
    function convertAndAddLiquidity(address _inTokenAddress, uint256 _amount, uint256 _minReceiveAmount, address _recipient) external {
        (bool switched, IERC20 tokenIn, IERC20 tokenOut) = _getInAndOut(_inTokenAddress);

        // Transfer tokenIn from msg.sender
        tokenIn.safeTransferFrom(msg.sender, address(this), _amount);

        // Swap half of tokenIn for tokenOut
        uint256 swapAmount = _amount / 2;
        uint256 swappedAmount = _swap(swapAmount, _minReceiveAmount, address(tokenIn), address(tokenOut), address(this));

        uint256 token0LiqAmount = switched ? swappedAmount : (_amount - swapAmount);
        uint256 token1LiqAmount = switched ? (_amount - swapAmount) : swappedAmount;
        _addLiquidity(token0LiqAmount, token1LiqAmount, _recipient);

        // Return leftover token to msg.sender
        uint256 remainBalance0 = token0.balanceOf(address(this));
        if (remainBalance0 > 0) token0.safeTransfer(msg.sender, remainBalance0);
        uint256 remainBalance1 = token1.balanceOf(address(this));
        if (remainBalance1 > 0) token1.safeTransfer(msg.sender, remainBalance1);
    }

    function _removeLiquidity(uint256 _amount, address _to) internal returns (uint256, uint256) {
        lp.safeApprove(address(router), _amount);

        (uint256 amountToken0, uint256 amountToken1) = router.removeLiquidity(
            address(token0),
            address(token1),
            _amount,
            0, // _amountAMin
            0, // _amountBMin
            _to,
            block.timestamp + 60
        );

        IERC20(token0).safeApprove(address(router), 0);
        return (amountToken0, amountToken1);
    }

    /// @notice Remove liquidity and convert returned token0 to token1 or vice versa, and send both to recipient.
    // NOTE: liquidity removed will return token0 and token1 at 50:50 ratio.
    /// @param _lpAmount The amount of lp token to remove
    /// @param _token0Percentage The percentage of token0 to preserve: 0~100. For example, 10 means
    // it will convert token0 and token1 to 10:90 ratio
    /// @param _recipient The recipient address of tokenOut
    function removeLiquidityAndConvert(uint256 _lpAmount, uint256 _token0Percentage, address _recipient) external {
        require((0 <= _token0Percentage) && (_token0Percentage <= 100), "Invalid token0 percentage");

        // Transfer lp token from msg.sender
        lp.safeTransferFrom(msg.sender, address(this), _lpAmount);
        (uint256 amountToken0, uint256 amountToken1) = _removeLiquidity(_lpAmount, address(this));

        // Swap specified proportion of token0 for token1
        address tokenIn;
        address tokenOut;
        uint256 swapAmount;
        if (_token0Percentage <= 50) {
            tokenIn = address(token0);
            tokenOut = address(token1);
            swapAmount = amountToken0 * (50 - _token0Percentage) / 50;
        } else {
            tokenIn = address(token1);
            tokenOut = address(token0);
            swapAmount = amountToken1 * (_token0Percentage - 50) / 50;
        }
        if (swapAmount > 0) {
            _swap(swapAmount, 0, tokenIn, tokenOut, _recipient);
        }

        uint256 remainBalance0 = token0.balanceOf(address(this));
        if (remainBalance0 > 0) token0.safeTransfer(_recipient, remainBalance0);
        uint256 remainBalance1 = token1.balanceOf(address(this));
        if (remainBalance1 > 0) token1.safeTransfer(_recipient, remainBalance1);
    }

    /* ========== RESTRICTED FUNCTIONS ========== */

    function recoverERC20(address tokenAddress, uint256 tokenAmount) external onlyOwner {
        IERC20(tokenAddress).safeTransfer(owner, tokenAmount);
    }

    function _authorizeUpgrade(address newImplementation) internal view override onlyOwner {}
}