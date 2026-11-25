// HTTP errors that map straight onto a client-visible error body. Routing and
// translation throw these; only the server turns them into a response.

export class ApiError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string;

  constructor(status: number, message: string, code: string, type = "invalid_request_error") {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.type = type;
    this.code = code;
  }
}

export function unsupportedParameter(name: string): ApiError {
  return new ApiError(
    400,
    `${name} is not supported by warm2api`,
    "unsupported_parameter",
    "invalid_request_error",
  );
}
