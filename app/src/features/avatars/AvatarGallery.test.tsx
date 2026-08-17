import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AvatarGallery } from "./AvatarGallery";
import { AVATAR_STATES, STATE_LABELS } from "./types";

describe("AvatarGallery", () => {
  it("renders one labeled avatar per state", () => {
    render(<AvatarGallery reduceMotion />);
    expect(screen.getAllByRole("img")).toHaveLength(AVATAR_STATES.length);
    for (const state of AVATAR_STATES) {
      expect(screen.getByText(STATE_LABELS[state])).toBeInTheDocument();
    }
  });
});
