import { render, screen } from "@testing-library/react";
import { Markdown } from "./markdown";

describe("Markdown", () => {
  it("renders bold, italic, and inline code", () => {
    const { container } = render(<Markdown text="**bold** *ital* `code`" />);
    expect(container.querySelector("strong")).toHaveTextContent("bold");
    expect(container.querySelector("em")).toHaveTextContent("ital");
    expect(container.querySelector("code")).toHaveTextContent("code");
  });

  it("renders http(s) links with safe rel", () => {
    render(<Markdown text="see [docs](https://example.com/docs)" />);
    const link = screen.getByRole("link", { name: "docs" });
    expect(link).toHaveAttribute("href", "https://example.com/docs");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("refuses non-http link schemes", () => {
    const { container } = render(<Markdown text="[click](javascript:alert(1))" />);
    expect(container.querySelector("a")).toBeNull();
    expect(container).toHaveTextContent("[click](javascript:alert(1))");
  });

  it("never emits raw HTML from the input", () => {
    const { container } = render(<Markdown text={'<img src=x onerror="pwn()"> <script>pwn()</script>'} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container).toHaveTextContent("<script>pwn()</script>");
  });

  it("renders unordered and ordered lists", () => {
    const { container } = render(<Markdown text={"- one\n- two\n\n1. first\n2. second"} />);
    const ul = container.querySelector("ul");
    const ol = container.querySelector("ol");
    expect(ul?.querySelectorAll("li")).toHaveLength(2);
    expect(ol?.querySelectorAll("li")).toHaveLength(2);
    expect(ol?.textContent).toContain("first");
  });

  it("renders fenced code blocks verbatim", () => {
    const { container } = render(<Markdown text={"```\nconst x = **not bold**;\n```"} />);
    const pre = container.querySelector("pre code");
    expect(pre).toHaveTextContent("const x = **not bold**;");
    expect(container.querySelector("strong")).toBeNull();
  });

  it("splits paragraphs on blank lines", () => {
    const { container } = render(<Markdown text={"first para\n\nsecond para"} />);
    const paras = container.querySelectorAll("p");
    expect(paras).toHaveLength(2);
  });
});
