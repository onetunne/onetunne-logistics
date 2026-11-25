/** Помилки предметної області з кодом для i18n і HTTP-статусом. */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly status: number = 400,
    readonly params: Record<string, string | number> = {},
  ) {
    super(code);
    this.name = "DomainError";
  }
}

export class NotFoundError extends DomainError {
  constructor(entity: string) {
    super("error.notFound", 404, { entity });
    this.name = "NotFoundError";
  }
}

/** Оптимістичне блокування: дані змінилися з моменту відкриття форми. */
export class ConflictError extends DomainError {
  constructor() {
    super("error.conflict", 409);
    this.name = "ConflictError";
  }
}
