import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';

type ErrorPayload = {
  message?: string | string[];
  error?: string;
  errorCode?: string;
};

const DEFAULT_ERROR_CODE = 'UNKNOWN_ERROR';

const toErrorCode = (message: string) => {
  const normalized = message
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  return normalized || DEFAULT_ERROR_CODE;
};

const resolveMessage = (payload: ErrorPayload | string | undefined) => {
  if (!payload) {
    return null;
  }
  if (typeof payload === 'string') {
    return payload;
  }
  if (Array.isArray(payload.message)) {
    return payload.message.join(' ');
  }
  if (typeof payload.message === 'string') {
    return payload.message;
  }
  if (typeof payload.error === 'string') {
    return payload.error;
  }
  return null;
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const isHttp = exception instanceof HttpException;
    const status = isHttp
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;
    const payload = isHttp
      ? (exception.getResponse() as ErrorPayload | string)
      : undefined;
    const message =
      resolveMessage(payload) ||
      (exception instanceof Error ? exception.message : null) ||
      'Unexpected error.';
    const errorCode =
      typeof payload === 'object' && payload?.errorCode
        ? payload.errorCode
        : toErrorCode(message);
    const errorLabel =
      typeof payload === 'object' && payload?.error ? payload.error : undefined;

    response.status(status).json({
      statusCode: status,
      message,
      error: errorLabel ?? (isHttp ? undefined : 'Internal Server Error'),
      errorCode,
    });
  }
}
