export const withSupabase = (
  _options: unknown,
  handler: (request: Request, context: unknown) => Promise<Response>,
) => handler;
