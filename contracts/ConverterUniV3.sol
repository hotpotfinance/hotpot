pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IUniswapV3SwapRouter.sol";
import "./lib/UniswapV3PathLib.sol";
import "./Converter.sol";

/// @title Added Uniswap V3 swap functionalities on top of Converter.
contract ConverterUniV3 is Converter {
    using SafeERC20 for IERC20;
    using Path for bytes;

    IUniswapV3SwapRouter public routerUniV3;

    function initialize(address _NATIVE_TOKEN, string memory _name, address _owner, IPancakeRouter _router) override external {
        revert("Not supported");
    }

    function initialize(
        address _NATIVE_TOKEN,
        string memory _name,
        address _owner,
        IPancakeRouter _router,
        IUniswapV3SwapRouter _routerUniV3
    ) external {
        require(keccak256(abi.encodePacked(name)) == keccak256(abi.encodePacked("")), "Already initialized");
        super.initializeOwner(_owner);

        NATIVE_TOKEN = _NATIVE_TOKEN;
        name = _name;
        router = _router;
        routerUniV3 = _routerUniV3;
    }

    /// @notice Convert specified amount of tokenIn to tokenOut and send both to recipient
    /// @param _inTokenAddress The address of tokenIn
    /// @param _amount The amount of tokenIn
    /// @param _convertPercentage The percentage of tokenIn amount to convert
    /// @param _outTokenAddress The address of tokenOut
    /// @param _minReceiveAmount The minimum amount of tokenOut expected to receive
    /// @param _recipient The recipient address of tokenOut
    /// @param _path The UniswapV3 path info
    function convertUniV3(
        address _inTokenAddress,
        uint256 _amount,
        uint256 _convertPercentage,
        address _outTokenAddress,
        uint256 _minReceiveAmount,
        address _recipient,
        bytes memory _path
    ) external {
        require((0 <= _convertPercentage) && (_convertPercentage <= 100), "Invalid convert percentage");

        IERC20 tokenIn = IERC20(_inTokenAddress);

        // Transfer tokenIn from msg.sender
        tokenIn.safeTransferFrom(msg.sender, address(this), _amount);

        // Swap specified proportion of tokenIn for tokenOut
        uint256 swapAmount = _amount * _convertPercentage / 100;
        uint256 swappedAmount = _convertUniV3ExactInput(
            _inTokenAddress,
            _outTokenAddress,
            _path,
            _recipient,
            swapAmount,
            _minReceiveAmount
        );

        // Return half of tokenIn
        tokenIn.safeTransfer(_recipient, (_amount - swapAmount));

        emit ConvertedUniV3(
             _inTokenAddress,
            _outTokenAddress,
            _path,
            _amount,
            swapAmount,
            swappedAmount,
            _recipient
        );
    }

    function _convertUniV3ExactInput(
        address tokenIn,
        address tokenOut,
        bytes memory path,
        address recipient,
        uint256 amountIn,
        uint256 amountOutMinimum
    ) internal returns (uint256 amount) {
        _validatePath(path, tokenIn, tokenOut);
        IERC20(tokenIn).safeApprove(address(routerUniV3), amountIn);
        return
            routerUniV3.exactInput(
                IUniswapV3SwapRouter.ExactInputParams({
                    path: path,
                    recipient: recipient,
                    deadline: block.timestamp + 60,
                    amountIn: amountIn,
                    amountOutMinimum: amountOutMinimum
                })
            );
    }

    function _validatePath(
        bytes memory _path,
        address _tokenIn,
        address _tokenOut
    ) internal pure {
        (address tokenA, address tokenB, ) = _path.decodeFirstPool();

        if (_path.hasMultiplePools()) {
            _path = _path.skipToken();
            while (_path.hasMultiplePools()) {
                _path = _path.skipToken();
            }
            (, tokenB, ) = _path.decodeFirstPool();
        }

        require(tokenA == _tokenIn, "UniswapV3: first element of path must match token in");
        require(tokenB == _tokenOut, "UniswapV3: last element of path must match token out");
    }

    /* ========== EVENTS ========== */

    event ConvertedUniV3(address tokenIn, address tokenOut, bytes path, uint256 initAmount, uint256 amountIn, uint256 amountOut, address recipient);
}