#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { convertPipeDatasetFile } from "./review-test-lib.mjs";

function helpText() {
  return `Convert a pipe-delimited Review Agent dataset to calibration CSV

Usage:
  node tests/chinese-review-calibration/convert-pipe-dataset.mjs INPUT.txt [OUTPUT.csv]

The input must use this header:
  global_order|draft_id|scenario_id|category|draft_text

If OUTPUT.csv is omitted, the CSV is written beside the input file.
`;
}

export async function main(argumentsList = process.argv.slice(2)) {
  if (argumentsList.includes("--help") || argumentsList.includes("-h")) {
    process.stdout.write(helpText());
    return 0;
  }
  if (argumentsList.length < 1 || argumentsList.length > 2) {
    throw new Error("Provide INPUT.txt and, optionally, OUTPUT.csv. Use --help for details.");
  }

  const inputPath = path.resolve(argumentsList[0]);
  const parsedInputPath = path.parse(inputPath);
  const outputPath = argumentsList[1]
    ? path.resolve(argumentsList[1])
    : path.join(parsedInputPath.dir, `${parsedInputPath.name}.csv`);
  if (inputPath.toLocaleLowerCase() === outputPath.toLocaleLowerCase()) {
    throw new Error("Input and output paths must be different.");
  }

  const result = await convertPipeDatasetFile(inputPath, outputPath);
  process.stdout.write(
    [
      `Converted ${result.rows.length} drafts.`,
      `CSV: ${result.outputPath}`,
      `Validation warnings: ${result.warnings.length}`,
    ].join("\n") + "\n",
  );
  return 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(`Dataset conversion failed: ${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}
