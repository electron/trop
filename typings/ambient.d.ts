declare module 'promise-events' {
  export class EventEmitter {}
}

declare module 'config-yml' {
  interface Config {
    tropEmail?: string;
    tropName?: string;
  }
  const foo: Config;
  export = foo;
}
