// 本地语音合成：Windows 走 WinRT SpeechSynthesizer，macOS 走自带的 `say` 命令。
// 在线 Edge 朗读会随微软改接口而失效，本地合成离线可用，作为兜底保证她一定有声音。
//
// 两条路的产物都是 WAV：调用方（tts.ts）按 `audio/wav` 处理，不用关心是哪边的。
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SPEECH_MIN_CHARS, stripForSpeech, TTS_RATE } from './speech'

/** 系统里最好听的中文女声；换成别的音色只改这一行。 */
const VOICE = 'Microsoft Yaoyao'

/** 一段话合成本来就一两秒，超过这个时间基本是卡死了，别再占着不放。 */
const SYNTH_TIMEOUT_MS = 15_000

/**
 * PowerShell 脚本，参数依次是「文本文件」「输出文件」。
 * System.Speech 只认 Desktop 音色（Huihui），OneCore 的 Yaoyao 更好听，
 * 只能走 WinRT，而 WinRT 的异步在 PowerShell 里得用 AsTask 手动转。
 *
 * 脚本正文里不要写中文：PowerShell 5.1 按系统 ANSI 读无 BOM 文件，
 * 中文注释会被解成乱码并破坏后续语法（实测报 Wait 处 AggregateException）。
 */
const SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReaderLoadOperation, Windows.Storage.Streams, ContentType = WindowsRuntime]

function Await($WinRtTask, $ResultType) {
    $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
    })[0]
    $netTask = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

$text = [IO.File]::ReadAllText($args[0], [Text.Encoding]::UTF8)
$outPath = $args[1]

$syn = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::new()
$voice = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.DisplayName -eq '${VOICE}' } | Select-Object -First 1
if ($voice) { $syn.Voice = $voice }

# Slightly faster than the voice default, matching the persona; escape the body
# so a single "&" cannot invalidate the whole SSML document.
$ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'><prosody rate='+${Math.round((TTS_RATE - 1) * 100)}%'>" + [Security.SecurityElement]::Escape($text) + "</prosody></speak>"
$stream = Await ($syn.SynthesizeSsmlToStreamAsync($ssml)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])

$reader = [Windows.Storage.Streams.DataReader]::new($stream)
Await ($reader.LoadAsync([uint32]$stream.Size)) ([uint32]) | Out-Null
$bytes = New-Object byte[] $stream.Size
$reader.ReadBytes($bytes)
[IO.File]::WriteAllBytes($outPath, $bytes)
`

/**
 * 用系统语音合成一段 wav；文本清洗后没有可念的内容时返回 null。
 * 失败抛错，由调用方决定是静默降级还是继续回退。
 */
export async function synthesizeLocalSpeech(
  text: string,
  options: { signal?: AbortSignal } = {}
): Promise<Buffer | null> {
  const spoken = stripForSpeech(text)
  if (spoken.length < SPEECH_MIN_CHARS) return null
  if (options.signal?.aborted) throw new Error('TTS 已取消')

  // 每次用独立临时目录，并发的两次合成不会互相踩到文本 / 输出文件
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-tts-'))
  const scriptPath = join(dir, 'synth.ps1')
  const textPath = join(dir, 'text.txt')
  const outPath = join(dir, 'out.wav')

  try {
    await writeFile(textPath, spoken, 'utf8')
    if (process.platform === 'darwin') {
      await runSay(textPath, outPath, options.signal)
    } else {
      await writeFile(scriptPath, SCRIPT, 'utf8')
      await runCommand(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, textPath, outPath],
        options.signal
      )
    }
    const audio = await readFile(outPath)
    return audio.length > 0 ? audio : null
  } finally {
    void rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * macOS 的 `say` 直接念成 WAV（不指定 file-format 的话默认是 AIFF，
 * 渲染层的 Blob 按 mime 建就播不出来了）。
 * 先试 Tingting（系统中文女声），机器上没装这个音色时退回默认音色——
 * 腔调可能不理想，但总比一句话都念不出来强。
 */
async function runSay(textPath: string, outPath: string, signal?: AbortSignal): Promise<void> {
  const args = ['-f', textPath, '-o', outPath, '--file-format=WAVE', '--data-format=LEI16@22050']
  try {
    await runCommand('say', ['-v', 'Tingting', ...args], signal)
  } catch (error) {
    if (signal?.aborted) throw error // 用户打断不是音色的问题，别接着合成一段他不要的
    await runCommand('say', args, signal)
  }
}

function runCommand(command: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true })
    // 报错信息在 stderr，不留下来就只能干瞪眼「合成失败」
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    const finish = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      child.kill()
      finish()
      reject(new Error('TTS 已取消'))
    }
    const timer = setTimeout(() => {
      child.kill()
      finish()
      reject(new Error('本地语音合成超时'))
    }, SYNTH_TIMEOUT_MS)

    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.on('error', (error) => {
      finish()
      reject(error)
    })
    child.on('close', (code) => {
      finish()
      if (code === 0) resolve()
      else reject(new Error(`本地语音合成失败（退出码 ${code}）：${stderr.trim()}`))
    })
  })
}
