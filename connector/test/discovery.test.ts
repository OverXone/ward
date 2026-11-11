import { describe, expect, it } from "vitest";
import { parseCommandLine, parseLockfile } from "../src/lcu/discovery";

describe("parseCommandLine", () => {
  it("reads port and token from LeagueClientUx.exe's quoted arguments", () => {
    const cmd = String.raw`"C:/Riot Games/League of Legends/LeagueClientUx.exe" "--riotclient-auth-token=abc" "--riotclient-app-port=50001" "--remoting-auth-token=Xy_Z-123abc" "--app-port=61234" "--install-directory=C:\Riot Games\League of Legends"`;
    expect(parseCommandLine(cmd)).toEqual({ port: 61234, password: "Xy_Z-123abc" });
  });

  it("does not confuse --riotclient-app-port with --app-port", () => {
    const cmd = `"--riotclient-app-port=50001" "--remoting-auth-token=tok" "--app-port=61234"`;
    expect(parseCommandLine(cmd)?.port).toBe(61234);
  });

  it("returns null when arguments are missing", () => {
    expect(parseCommandLine(`"LeagueClientUx.exe" "--app-port=61234"`)).toBeNull();
    expect(parseCommandLine("")).toBeNull();
  });
});

describe("parseLockfile", () => {
  it("parses name:pid:port:password:protocol", () => {
    expect(parseLockfile("LeagueClient:1234:61234:p4ss_w-rd:https\n")).toEqual({ pid: 1234, port: 61234, password: "p4ss_w-rd" });
  });

  it("rejects malformed content", () => {
    expect(parseLockfile("LeagueClient:1234:61234")).toBeNull();
    expect(parseLockfile("LeagueClient:x:61234:pw:https")).toBeNull();
    expect(parseLockfile("LeagueClient:1:99999:pw:https")).toBeNull();
    expect(parseLockfile("LeagueClient:1:61234:pw:http")).toBeNull();
  });
});
