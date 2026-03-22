type TestCase = {
  name: string;
  fn: () => Promise<void> | void;
};

const cases: TestCase[] = [];

export function test(name: string, fn: () => Promise<void> | void): void {
  cases.push({ name, fn });
}

export async function run(): Promise<void> {
  let failures = 0;

  for (const entry of cases) {
    try {
      await entry.fn();
      console.log(`ok - ${entry.name}`);
    } catch (error) {
      failures += 1;
      console.error(`not ok - ${entry.name}`);
      console.error(error);
    }
  }

  console.log(`${cases.length} tests, ${failures} failures`);

  if (failures > 0) {
    process.exitCode = 1;
  }
}
