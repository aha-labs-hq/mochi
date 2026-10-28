declare module "*.css";
declare module "*.svg" {
  const url: string;
  export default url;
}
declare module "*.png" {
  const url: string;
  export default url;
}
declare module "*.webp" {
  const url: string;
  export default url;
}
declare module "*.md?raw" {
  const content: string;
  export default content;
}
