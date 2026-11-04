declare module "socket.io-msgpack-parser" {
  const parser: {
    protocol: number;
    Encoder: new () => unknown;
    Decoder: new () => unknown;
  };
  export default parser;
}
