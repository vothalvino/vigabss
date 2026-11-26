/** An image fetched with credentials, as a data: URL an <img> or tab icon can show. */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('could not read the image'));
    reader.readAsDataURL(blob);
  });
}
