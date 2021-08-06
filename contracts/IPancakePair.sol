pragma solidity >=0.5.0 <0.9.0;

interface IPancakePair {
    function token0() external returns (address);
    function token1() external returns (address);
}