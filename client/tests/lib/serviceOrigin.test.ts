import {
  resolveServiceAccessToken,
  serviceAuthSubprotocol,
  setServiceConnection,
} from "@/lib/serviceOrigin";

describe("service connection", () => {
  afterEach(() => setServiceConnection("", ""));

  it("encodes an access token in a WebSocket-safe subprotocol", () => {
    setServiceConnection("http://192.168.1.20:5772", "LAN-secret_123");

    const protocol = serviceAuthSubprotocol();
    expect(protocol).toMatch(/^stereovisor\.auth\.[A-Za-z0-9_-]+$/);
    const encoded = protocol!.slice("stereovisor.auth.".length);
    const padded = encoded.replace(/-/g, "+").replace(/_/g, "/").padEnd(
      Math.ceil(encoded.length / 4) * 4,
      "=",
    );
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)),
    );
    expect(decoded).toBe("LAN-secret_123");
    expect(resolveServiceAccessToken()).toBe("LAN-secret_123");
  });
});
