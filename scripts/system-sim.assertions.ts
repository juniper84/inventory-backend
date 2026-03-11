export type AssertionResult = {
  name: string;
  passed: boolean;
  detail?: string;
};

type AssertionInput = {
  branchIds: string[];
  authedRequest: <T>(route: string) => Promise<T>;
};

const asNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export const runSimulationAssertions = async (
  input: AssertionInput,
): Promise<AssertionResult[]> => {
  const results: AssertionResult[] = [];
  const branchId = input.branchIds[0];

  try {
    const stock = await input.authedRequest<Array<Record<string, unknown>>>(
      `/reports/stock?branchId=${branchId}`,
    );
    const negative = stock.find((row) => {
      const qty = asNumber(row.quantity);
      return qty !== null && qty < 0;
    });
    results.push({
      name: 'stock.non_negative',
      passed: !negative,
      detail: negative ? 'Found negative quantity in stock report.' : 'OK',
    });
  } catch (error) {
    results.push({
      name: 'stock.non_negative',
      passed: false,
      detail: `Failed to evaluate stock report: ${(error as Error).message}`,
    });
  }

  try {
    const sales = await input.authedRequest<Array<Record<string, unknown>>>(
      `/reports/sales?branchId=${branchId}`,
    );
    results.push({
      name: 'sales.non_empty',
      passed: Array.isArray(sales) && sales.length > 0,
      detail: `rows=${Array.isArray(sales) ? sales.length : 0}`,
    });
  } catch (error) {
    results.push({
      name: 'sales.non_empty',
      passed: false,
      detail: `Failed to evaluate sales report: ${(error as Error).message}`,
    });
  }

  try {
    const pnl = await input.authedRequest<{
      totals?: Record<string, unknown>;
    }>(`/reports/pnl?branchId=${branchId}`);
    const totals = pnl?.totals ?? {};
    const grossProfit = asNumber(totals.grossProfit);
    const losses = asNumber(totals.losses);
    const expenses = asNumber(totals.expenses);
    const transferFees = asNumber(totals.transferFees);
    const netProfit = asNumber(totals.netProfit);
    const computable =
      grossProfit !== null &&
      losses !== null &&
      expenses !== null &&
      transferFees !== null &&
      netProfit !== null;
    const expected = computable
      ? grossProfit - losses - expenses - transferFees
      : null;
    const passed =
      expected !== null && netProfit !== null
        ? Math.abs(expected - netProfit) < 0.01
        : false;
    results.push({
      name: 'pnl.net_profit_reconciles',
      passed,
      detail:
        expected === null || netProfit === null
          ? 'Missing required totals fields.'
          : `expected=${expected.toFixed(2)} actual=${netProfit.toFixed(2)}`,
    });
  } catch (error) {
    results.push({
      name: 'pnl.net_profit_reconciles',
      passed: false,
      detail: `Failed to evaluate pnl report: ${(error as Error).message}`,
    });
  }

  return results;
};
