export type TranslationTree = {
  readonly [key: string]: string | TranslationTree
}

export type TranslationShape<T> = {
  readonly [Key in keyof T]: T[Key] extends string
    ? string
    : T[Key] extends TranslationTree
      ? TranslationShape<T[Key]>
      : never
}
