library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use std.env.all;

-- The testbench has no external ports: it generates inputs and checks outputs.
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

  -- Toggles every 5 ns, giving a full clock period of 10 ns.
  clk <= not clk after 5 ns;

  stimulus : process
  begin
    -- 0 to 20 ns: reset.
    wait for 20 ns;
    assert count = to_unsigned(0, 4)
      report "Initial reset failed" severity failure;
    rst <= '0';
    en  <= '1';

    -- 20 to 100 ns: count eight enabled clock edges.
    wait for 80 ns;
    assert count = to_unsigned(8, 4)
      report "Expected 8 after eight enabled clock edges" severity failure;
    en <= '0';

    -- 100 to 130 ns: hold; the output must remain 8.
    wait for 30 ns;
    assert count = to_unsigned(8, 4)
      report "Counter changed while disabled" severity failure;
    en <= '1';

    -- 130 to 230 ns: resume; wrap from 15 to 0 and finish at 2.
    wait for 100 ns;
    assert count = to_unsigned(2, 4)
      report "Counter wraparound failed" severity failure;
    rst <= '1';
    en  <= '0';

    -- 230 to 250 ns: reset again.
    wait for 20 ns;
    assert count = to_unsigned(0, 4)
      report "Second reset failed" severity failure;
    rst <= '0';
    en  <= '1';

    -- 250 to 280 ns: count three more edges, then finish the simulation normally.
    wait for 30 ns;
    assert count = to_unsigned(3, 4)
      report "Expected 3 after restarting" severity failure;
    report "TB_PASS: reset, enable, hold and wraparound checked" severity note;
    finish;
    wait;
  end process stimulus;
end architecture sim;
