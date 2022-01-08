pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract StubPancakePair is ERC20 {

    // string public name;
    address immutable public token0;
    address immutable public token1;

    constructor(
        address _token0,
        address _token1
    ) public ERC20("Stub", "STUB") {
        token0 = _token0;
        token1 = _token1;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}