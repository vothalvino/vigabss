# Huawei eOTDR capture form

VigaBSS can mark a PON port as having a transceiver with an embedded OTDR
(eOTDR), but it does not read eOTDR measurements yet. The commands differ
between software releases and are not in any public reference, and an OTDR
test is started on the OLT, so they are not guessed.

Fill this form in from a real OLT and attach it to an issue. With it, the
reading can be implemented and tested against exactly what the OLT prints.

**Copy text, not screenshots, and include the prompt on every line**
(`MA5800-X7(config-if-gpon-0/1)#`), so it is clear which mode each command
runs in. Replace serial numbers and customer names with made-up ones.

## Environment

- **Device / model:** for example SmartAX MA5800-X7
- **Board / optical module:** for example GPSF with a Class C+ eOTDR module
- **Software version and patch:** output of `display version`
- **Interface used:** CLI, SNMP, or iMaster NCE-FAN REST

## 1. Pre-check: the port and its ONUs

Whatever your release accepts for listing the optical information of the
ONUs on the port (often typed inside the GPON interface view).

```text
[prompt and command]
[exact output]
```

## 2. Starting an eOTDR test

```text
[prompt and exact command, SNMP SET, or HTTP request]
[exact output, including any "{ <cr>|... }:" hint and any "(y/n)" question]
```

- **Does the OLT ask for confirmation?** Paste the question exactly.
- **How long does the test take?**
- **Is service on that PON port interrupted while it runs?**

## 3. Reading the result

Ask for the result once while the test is still running, and once after it
has finished.

```text
[prompt and command, while running]
[exact output]
```

```text
[prompt and command, when finished]
[exact output, including pager lines such as ---- More ( Press 'Q' to break ) ----]
```

## 4. A healthy fibre and a broken one

If possible, on the same port:

```text
[result with the fibre intact]
```

```text
[result with the fibre cut or unplugged]
```

- **Real fibre length or cut position, if known:** this confirms which field
  is the distance and in which unit.

## 5. Failures

### A port whose module has no eOTDR

```text
[exact output]
```

### Port busy, or a test already running

```text
[exact output]
```

## What VigaBSS does without eOTDR

Reading a PON port already reports a suspected break and an upper limit on
its distance, from which ONUs lost their optical signal and how far each one
was while it was online. See "OLT command line" in `ARCHITECTURE.md`. An
eOTDR reading would replace that upper limit with a measured distance.
