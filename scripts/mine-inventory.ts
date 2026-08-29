/** Print the Step 1.1 inventory of the VS Code workspace storage source. */
import { inventorySource } from '../src/mine/inventory';

function main(): void {
  const report = inventorySource();
  console.log(`Source: ${report.sourceDir}`);
  console.log(`Workspace folders with chatSessions: ${report.workspaceCount}`);
  console.log(`JSONL conversation files: ${report.jsonlCount}`);
  if (report.dateRange.earliest !== null) {
    console.log(`Date range: ${report.dateRange.earliest} .. ${report.dateRange.latest}`);
  } else {
    console.log('Date range: (none found)');
  }
}

main();
