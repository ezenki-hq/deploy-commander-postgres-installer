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

export class PostgresRequestError extends Error {
  readonly status: 400 | 404 | 409 | 499;

  constructor(status: 400 | 404 | 409 | 499, message: string) {
    super(message);
    this.status = status;
    this.name = 'PostgresRequestError';
  }
}
