@echo off
rem StratInfer: build the Strata engine from a checkout, CUDA 13.x, sm_120 (RTX 50) only.
rem   build-engine.bat <source dir> <build dir>
rem env (all optional):
rem   CUDA_ROOT  default: C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.1
rem   CUDA_ARCH  default: 120-real (RTX 50); set 89-real for an Ada smoke build
rem   GGML       the PINNED llama.cpp checkout (see README "Build": the commit listed in
rem              <checkout>\third_party\ggml\VERSION.txt - a newer llama.cpp breaks the
rem              MMQ overlay with signature mismatches on new_pool_for_device)
rem   VSVC       path to vcvars64.bat (default VS2022 BuildTools)
rem Requires on PATH: cmake >= 3.24 and ninja (pip install -r requirements-build.txt).
setlocal
set "SRCD=%~1"
set "BD=%~2"
if "%SRCD%"=="" ( echo usage: build-engine.bat ^<source^> ^<build dir^> & exit /b 2 )
if "%BD%"=="" ( echo usage: build-engine.bat ^<source^> ^<build dir^> & exit /b 2 )
if "%CUDA_ROOT%"=="" set "CUDA_ROOT=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.1"
if "%CUDA_ARCH%"=="" set "CUDA_ARCH=120-real"
if "%VSVC%"=="" set "VSVC=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%CUDA_ROOT%\bin\nvcc.exe" ( echo nvcc not found at "%CUDA_ROOT%" & exit /b 3 )
if "%GGML%"=="" ( echo set GGML to the pinned llama.cpp checkout ^(see third_party\ggml\VERSION.txt^) & exit /b 6 )
call "%VSVC%" >nul
cmake -G Ninja -S "%SRCD%" -B "%BD%" ^
  -DCMAKE_BUILD_TYPE=Release ^
  -DSTRATA_ENABLE_CUDA=ON ^
  -DSTRATA_BUILD_TESTS=ON ^
  -DSTRATA_PORTABLE=OFF ^
  "-DCMAKE_CUDA_ARCHITECTURES=%CUDA_ARCH%" ^
  "-DCMAKE_CUDA_COMPILER=%CUDA_ROOT%/bin/nvcc.exe" ^
  "-DCUDAToolkit_ROOT=%CUDA_ROOT%" ^
  -DSTRATA_GGML_DIR="%GGML%"
if not "%ERRORLEVEL%"=="0" exit /b 4
cmake --build "%BD%" -j 8 --target strata strata-q36 json_automaton_test gguf_tokens_test qwen35_philox_test grammar_mask_parity
if not "%ERRORLEVEL%"=="0" exit /b 5
ctest --test-dir "%BD%" -R "json_automaton_test|gguf_tokens_test|qwen35_philox_test|grammar_mask_parity" --output-on-failure
if not "%ERRORLEVEL%"=="0" exit /b 7
echo BUILT: %BD%
exit /b 0
