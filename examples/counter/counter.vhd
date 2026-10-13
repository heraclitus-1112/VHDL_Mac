library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

-- 被测设计：4 位计数器，范围为 0 到 15。
-- 只在时钟上升沿工作；复位优先于使能。
entity counter is
  port (
    clk   : in  std_logic;
    rst   : in  std_logic;
    en    : in  std_logic;
    count : out unsigned(3 downto 0)
  );
end entity counter;

architecture rtl of counter is
  signal value : unsigned(3 downto 0) := (others => '0');
begin
  process (clk)
  begin
    if rising_edge(clk) then
      if rst = '1' then
        value <= (others => '0');
      elsif en = '1' then
        value <= value + 1;
      end if;
    end if;
  end process;

  count <= value;
end architecture rtl;
