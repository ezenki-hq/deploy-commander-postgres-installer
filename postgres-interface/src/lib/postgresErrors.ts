export class PostgresRecoveryRequiredError extends Error {
  constructor() {
    super('PostgreSQL recovery is required');
    this.name = 'PostgresRecoveryRequiredError';
  }
}

export class OperationBusyError extends Error {
  constructor() {
    super('A PostgreSQL operation is already in progress');
    this.name = 'OperationBusyError';
  }
}
