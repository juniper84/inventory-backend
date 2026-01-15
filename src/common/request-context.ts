export function getBusinessId(
  headers: Record<string, string | string[] | undefined>,
) {
  const value = headers['x-business-id'];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}
