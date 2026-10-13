library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use std.env.all;

-- Testbench 没有外部端口：它自己生成输入，并检查输出。
entity tb_counter is
end entity tb_counter;

architecture sim of tb_counter is
  signal clk   : std_logic := '0';
  signal rst   : std_logic := '1';
  signal en    : std_logic := '0';
  signal count : unsigned(3 downto 0);
begin
  dut : entity work.counter(rtl)
    port map (clk => clk, rst => rst, en => en, count => count);

  -- 每 5 ns 翻转一次，所以完整时钟周期为 10 ns。
  clk <= not clk after 5 ns;

  stimulus : process
  begin
    -- 0 到 20 ns：复位。
    wait for 20 ns;
    assert count = to_unsigned(0, 4)
      report "Initial reset failed" severity failure;
    rst <= '0';
    en  <= '1';

    -- 20 到 100 ns：计数 8 次。
    wait for 80 ns;
    assert count = to_unsigned(8, 4)
      report "Expected 8 after eight enabled clock edges" severity failure;
    en <= '0';

    -- 100 到 130 ns：暂停，输出应保持 8。
    wait for 30 ns;
    assert count = to_unsigned(8, 4)
      report "Counter changed while disabled" severity failure;
    en <= '1';

    -- 130 到 230 ns：继续计数；15 后回到 0，最终为 2。
    wait for 100 ns;
    assert count = to_unsigned(2, 4)
      report "Counter wraparound failed" severity failure;
    rst <= '1';
    en  <= '0';

    -- 230 到 250 ns：再次复位。
    wait for 20 ns;
    assert count = to_unsigned(0, 4)
      report "Second reset failed" severity failure;
    rst <= '0';
    en  <= '1';

    -- 250 到 280 ns：再计数 3 次，并正常结束仿真。
    wait for 30 ns;
    assert count = to_unsigned(3, 4)
      report "Expected 3 after restarting" severity failure;
    report "TB_PASS: reset, enable, hold and wraparound checked" severity note;
    finish;
    wait;
  end process stimulus;
end architecture sim;
