# Mode-Specific Image Size Controls

## Goal

Replace the Manhwa width dropdown with a faster `− 30% +` stepper while keeping the existing Manga thumbnail-size dropdown exclusive to Manga mode.

## Behavior

- Manhwa mode shows the width stepper and hides the Manga thumbnail-size dropdown.
- Manga mode hides the width stepper and shows the existing `Small`, `Medium`, and `Large` dropdown.
- Manhwa width starts at 30%, changes by 5% per click, and is clamped to 10–100%.
- The current width is displayed between the buttons.
- The minus button is disabled at 10%; the plus button is disabled at 100%.
- Switching modes preserves the selected Manhwa width instead of resetting it.

## Implementation

- Replace `#modalMaxWidthSelect` in `index.html` with a Manhwa control group containing two native buttons and a live percentage label.
- Give the Manga dropdown and Manhwa stepper separate wrappers so one mode-switch function can toggle their visibility.
- Reuse `maxWidthVW` as the single Manhwa width state in `script.js`.
- Each stepper click updates `maxWidthVW`, the percentage label, the boundary button states, and the widths of rendered Manhwa images.
- Add only the CSS needed to match the existing header controls and to hide inactive mode controls.

## Accessibility

- Use native `button` elements with explicit accessible labels.
- Expose the current percentage as text and an `aria-live="polite"` value.
- Use the native `disabled` state at both limits.

## Verification

- Automated checks cover mode-specific visibility, 5% stepping, and both 10%/100% boundaries.
- Browser verification covers initial Manhwa state, repeated stepping, disabled boundary buttons, mode switching, and Manga dropdown behavior.

## Non-goals

- No persistence of width or thumbnail size.
- No keyboard shortcuts, slider, press-and-hold repeat, or new dependency.
