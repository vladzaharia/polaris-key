using System.Reflection;
var asm = typeof(System.IO.Compression.ZipArchive).Assembly;
foreach (var t in asm.GetExportedTypes().Where(t => t.Name.Contains("Zstandard")).OrderBy(t => t.Name)) {
    Console.WriteLine($"{(t.IsEnum ? "enum" : t.IsValueType ? "struct" : "class")} {t.FullName}");
    foreach (var m in t.GetMembers(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly).OrderBy(m => m.Name))
        if (m is not MethodInfo mi || !mi.IsSpecialName) Console.WriteLine("   " + m.ToString());
}
Console.WriteLine(System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription);
