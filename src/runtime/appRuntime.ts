import type { Gateway } from "./gateway";
import type { ControlServer } from "../web/controlServer";

export class AppRuntime {
  constructor(
    private readonly gateway: Gateway,
    private readonly controlServer: ControlServer,
  ) {}

  async start(): Promise<void> {
    await this.gateway.start();
    await this.controlServer.start();
  }
}
