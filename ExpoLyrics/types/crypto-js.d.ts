declare module "crypto-js" {
  interface WordArray {
    toString(encoder?: unknown): string;
  }
  const CryptoJS: {
    SHA256(value: string): WordArray;
    enc: { Hex: unknown };
  };
  export default CryptoJS;
}
