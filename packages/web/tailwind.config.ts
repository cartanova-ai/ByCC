import typography from "@tailwindcss/typography";
import { type Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  plugins: [typography],
};

export default config;
