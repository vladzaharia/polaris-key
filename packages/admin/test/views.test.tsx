import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { AdminProvider } from "../src/context.js";
import type { Me } from "../src/api.js";
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  Field,
  Input,
  type ColumnDef,
} from "../src/components/ui/index.js";
import { ThemeProvider, useTheme } from "../src/components/theme.js";
import { Logo } from "../src/components/brand/Logo.js";
import { Dashboard } from "../src/views/Dashboard.js";
import { ComingSoon } from "../src/views/ComingSoon.js";

// Foundation-level smoke tests: the primitive layer + brand + placeholder views compile,
// render, and behave. View-specific behavior belongs to the agents building those views.

const ME: Me = {
  sub: "u1",
  name: "Ada Lovelace",
  email: "ada@x.io",
  csrf: "csrf",
  platformAdmin: true,
  products: [{ slug: "djdl", name: "DJDL", schemaVersion: 2 }],
};

function withAdmin(node: ReactElement) {
  return render(
    <AdminProvider
      value={{ me: ME, product: "djdl", setProduct: () => undefined }}
    >
      {node}
    </AdminProvider>,
  );
}

beforeEach(() => {
  (
    Element.prototype as unknown as { hasPointerCapture: () => boolean }
  ).hasPointerCapture = () => false;
});
afterEach(cleanup);

describe("Button primitive", () => {
  it("renders, fires onClick, and disables while loading", async () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Save</Button>);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(
      <Button onClick={onClick} loading>
        Save
      </Button>,
    );
    expect(
      (screen.getByRole("button", { name: /Save/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe("Field primitive", () => {
  it("wires the label, help, and error to the control via aria-describedby + aria-invalid", () => {
    render(
      <Field label="Email" help="we never share it" error="required">
        <Input />
      </Field>,
    );
    const input = screen.getByLabelText("Email");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const describedBy = input.getAttribute("aria-describedby") ?? "";
    expect(describedBy.split(" ").length).toBe(2);
    expect(screen.getByRole("alert").textContent).toBe("required");
  });
});

describe("Badge + EmptyState primitives", () => {
  it("renders a badge with its label and an empty state with an action", () => {
    render(
      <>
        <Badge variant="success">active</Badge>
        <EmptyState title="Nothing here" action={<Button>Add</Button>} />
      </>,
    );
    expect(screen.getByText("active")).toBeTruthy();
    expect(screen.getByText("Nothing here")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
  });
});

describe("DataTable primitive", () => {
  interface Row {
    id: string;
    name: string;
    count: number;
  }
  const rows: Row[] = [
    { id: "a", name: "Charlie", count: 3 },
    { id: "b", name: "Alice", count: 1 },
    { id: "c", name: "Bob", count: 2 },
  ];
  const columns: ColumnDef<Row>[] = [
    {
      id: "name",
      header: "Name",
      cell: (r) => r.name,
      accessor: (r) => r.name,
      sortable: true,
    },
    {
      id: "count",
      header: "Count",
      cell: (r) => r.count,
      accessor: (r) => r.count,
      sortable: true,
    },
  ];

  it("renders rows and supports client-side sort", async () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />);
    expect(screen.getByText("Charlie")).toBeTruthy();
    // Sort by name ascending.
    await userEvent.click(screen.getByRole("button", { name: /Name/ }));
    const cells = screen.getAllByRole("cell").map((c) => c.textContent);
    // First data cell should now be "Alice".
    expect(cells[0]).toBe("Alice");
  });

  it("filters rows via the global filter", () => {
    render(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        filterable
      />,
    );
    fireEvent.change(screen.getByLabelText("Filter rows"), {
      target: { value: "bob" },
    });
    expect(screen.getByText("Bob")).toBeTruthy();
    expect(screen.queryByText("Charlie")).toBeNull();
  });

  it("shows the empty state when there are no rows", () => {
    render(
      <DataTable
        columns={columns}
        rows={[]}
        rowKey={(r) => r.id}
        empty={<EmptyState title="No data" />}
      />,
    );
    expect(screen.getByText("No data")).toBeTruthy();
  });
});

describe("ConfirmDialog primitive", () => {
  it("invokes onConfirm when confirmed", async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={() => undefined}
        title="Delete it?"
        confirmLabel="Delete"
        onConfirm={onConfirm}
      />,
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete" }),
    );
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("theme toggle", () => {
  it("flips the document class between dark and light", async () => {
    function Toggle(): ReactElement {
      const { theme, toggle } = useTheme();
      return <button onClick={toggle}>theme:{theme}</button>;
    }
    render(
      <ThemeProvider>
        <Toggle />
      </ThemeProvider>,
    );
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    await userEvent.click(screen.getByText(/theme:/));
    expect(document.documentElement.classList.contains("light")).toBe(true);
  });
});

describe("brand + placeholder views", () => {
  it("renders the Polaris Key logo lockup", () => {
    render(<Logo subtitle="admin" />);
    expect(screen.getByLabelText("Polaris Key")).toBeTruthy();
    expect(screen.getByText("admin")).toBeTruthy();
  });

  it("Dashboard greets the operator and lists products", () => {
    withAdmin(<Dashboard />);
    expect(screen.getByText(/Welcome, Ada/)).toBeTruthy();
    expect(screen.getByText("DJDL")).toBeTruthy();
  });

  it("ComingSoon renders a labelled placeholder", () => {
    render(<ComingSoon title="Releases" />);
    expect(screen.getByText("Releases — coming soon")).toBeTruthy();
  });
});
