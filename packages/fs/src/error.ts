export class FsError extends Error {
  name = 'FsError'

  constructor(public code: FsError.Code, public url: URL, message: string) {
    super(message)
  }
}

export namespace FsError {
  export type Code =
    /** No provider is mounted for the location. */
    | 'NoProvider'
    /** The provider of the location does not implement the operation. */
    | 'NotSupported'
}
