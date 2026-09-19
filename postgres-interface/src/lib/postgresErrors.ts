export class PostgresRecoveryRequiredError extends Error {
  constructor() {
    super('PostgreSQL recovery is required');
    this.name = 'PostgresRecoveryRequiredError';
  }
}

export class PostgresNotInstalledError extends Error {
  constructor() {
    super('PostgreSQL is not installed');
    this.name = 'PostgresNotInstalledError';
  }
}

export class PostgresResourceAmbiguousError extends Error {
  constructor() {
    super('Multiple PostgreSQL resources were found');
    this.name = 'PostgresResourceAmbiguousError';
  }
}

export class PostgresResourceConfigurationError extends PostgresRecoveryRequiredError {
  constructor() {
    super();
    this.name = 'PostgresResourceConfigurationError';
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
