export class ComputerUseError extends Error {
  constructor(message, code = 'COMPUTER_OPERATION_FAILED') {
    super(message);
    this.name = 'ComputerUseError';
    this.code = code;
  }
}

export function unavailable(message) {
  return new ComputerUseError(message, 'COMPUTER_UNAVAILABLE');
}

export function unsupported(message) {
  return new ComputerUseError(message, 'COMPUTER_UNSUPPORTED');
}
