import {describe,expect,it} from "vitest";
import {serverConfig} from "../apps/server/src/config";
describe("production runtime configuration",()=>{
 it("uses file metadata only for local development",()=>{
   expect(serverConfig({})).toMatchObject({driver:"file",port:8080,dataFile:".data/rooms.json"});
   expect(()=>serverConfig({NODE_ENV:"production"})).toThrow("TCB_ENV_ID");
   expect(()=>serverConfig({NODE_ENV:"production",STORAGE_DRIVER:"file"})).toThrow("cloudbase");
 });
 it("needs only two deployment values with safe production defaults",()=>{
   expect(serverConfig({NODE_ENV:"production",TCB_ENV_ID:"env",CLOUDBASE_APIKEY:"secret"})).toMatchObject({driver:"cloudbase",port:8080,collection:"chat_rooms",leaseCollection:"chat_runtime",publicDir:"apps/web/dist"});
   expect(()=>serverConfig({NODE_ENV:"production",TCB_ENV_ID:"env"})).toThrow("CLOUDBASE_APIKEY");
 });
 it("requires server-side CloudBase credentials and honors PORT",()=>{
   expect(()=>serverConfig({STORAGE_DRIVER:"cloudbase"})).toThrow("TCB_ENV_ID");
   expect(()=>serverConfig({STORAGE_DRIVER:"cloudbase",TCB_ENV_ID:"env"})).toThrow("CLOUDBASE_APIKEY");
   expect(serverConfig({NODE_ENV:"production",STORAGE_DRIVER:"cloudbase",TCB_ENV_ID:"env",CLOUDBASE_APIKEY:"secret",PORT:"8080"})).toMatchObject({port:8080,driver:"cloudbase",environment:"env"});
 });
 it("rejects invalid ports/drivers and overlapping lease/room collections",()=>{
   expect(()=>serverConfig({PORT:"-1"})).toThrow("PORT");
   expect(()=>serverConfig({STORAGE_DRIVER:"unknown"})).toThrow("STORAGE_DRIVER");
   expect(()=>serverConfig({STORAGE_DRIVER:"cloudbase",TCB_ENV_ID:"env",CLOUDBASE_APIKEY:"key",CLOUDBASE_COLLECTION:"same",CLOUDBASE_LEASE_COLLECTION:"same"})).toThrow("collection");
 });
});
