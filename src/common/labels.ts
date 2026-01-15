export function shortId(id?: string | null, length = 6) {
  if (!id) {
    return '';
  }
  return id.slice(0, length);
}

export function labelWithFallback(params: {
  name?: string | null;
  id?: string | null;
  fallback?: string;
}) {
  if (params.name && params.name.trim()) {
    return params.name.trim();
  }
  if (params.id) {
    return `#${shortId(params.id)}`;
  }
  return params.fallback ?? 'Unknown';
}

export function formatVariantLabel(params: {
  id: string;
  name: string;
  productName?: string | null;
}) {
  const variantName = labelWithFallback({ name: params.name, id: params.id });
  const productName = params.productName?.trim();
  return productName ? `${productName} - ${variantName}` : variantName;
}
