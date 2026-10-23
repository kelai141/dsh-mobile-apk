export const MANAGED_PORT_MARKER = 'dsh-mobile managed atomic port bind (EP1)'
const before = '\t\t\tawait new Promise((resolve, reject) => {\n'
  + '\t\t\t\tthis.server.once("error", reject);\n'
  + '\t\t\t\tthis.server.listen(this.config.port, this.config.host, () => {\n'
  + '\t\t\t\t\tthis.server.off("error", reject);\n'
  + '\t\t\t\t\tthis.server.on("error", (err) => {\n'
  + '\t\t\t\t\t\tthis.ctx.logger.error(err);\n'
  + '\t\t\t\t\t});\n'
  + '\t\t\t\t\tthis.listenedPort = this.server.address().port;\n'
  + '\t\t\t\t\tresolve();\n'
  + '\t\t\t\t});\n'
  + '\t\t\t});'

export const MANAGED_LISTEN_BLOCK = `/* ${MANAGED_PORT_MARKER} */
await new Promise((resolve, reject) => {
  const managed = process.env.DSH_MOBILE_MANAGED_ENGINE === "1" && this.config.host === "127.0.0.1";
  let retried = false;
  const onError = (error) => {
    if (managed && !retried && error.code === "EADDRINUSE" && this.config.port !== 0) {
      retried = true;
      this.server.once("error", onError);
      this.server.listen(0, this.config.host);
      return;
    }
    this.server.off("listening", onListening);
    reject(error);
  };
  const onListening = () => {
    this.server.off("error", onError);
    this.server.on("error", (error) => { this.ctx.logger.error(error); });
    this.listenedPort = this.server.address().port;
    if (managed) process.env.DSH_ENGINE_PORT = String(this.listenedPort);
    resolve();
  };
  this.server.once("error", onError);
  this.server.once("listening", onListening);
  this.server.listen(this.config.port, this.config.host);
});`

export const hasManagedPortBind = source => source.includes(MANAGED_LISTEN_BLOCK)
export function patchManagedPortBind(source) {
  if (hasManagedPortBind(source)) return source
  if (source.includes(MANAGED_PORT_MARKER)) throw new Error('EP1 partial marker: refusing drift')
  if (source.split(before).length !== 2) throw new Error('EP1 expected one listen anchor')
  return source.replace(before, MANAGED_LISTEN_BLOCK)
}
