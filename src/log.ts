import { chalk } from "zx";

export function info(message: string): void {
  console.log(message);
}

export function warn(message: string): void {
  console.error(chalk.yellow(`Warning: ${message}`));
}

export function error(message: string): void {
  console.error(chalk.red(message));
}

export function success(message: string): void {
  console.log(chalk.green(message));
}

export function heading(message: string): void {
  console.log(chalk.bold(message));
}
