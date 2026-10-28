declare module "*&picture" {
  const picture: import("../build/pictures.ts").Picture;
  export default picture;
}

declare module "*&png" {
  const url: string;
  export default url;
}
